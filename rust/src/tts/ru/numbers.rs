//! Russian number verbalization for the Vosk-TTS path (#891).
//!
//! Vosk's G2P drops bare digits without a sound, so every digit run is
//! rewritten to words before synthesis. Russian numerals decline, and a full
//! declension engine is out of scope here; what this module covers is the set
//! of forms that are both frequent and unambiguous from the neighbouring word:
//!
//! - cardinals in nominative — the base layer («405» → «четыреста пять»);
//! - `HH:MM` → «четырнадцать тридцать»;
//! - a day before a genitive month name → ordinal genitive
//!   («25 декабря» → «двадцать пятого декабря»);
//! - a year before «год»/«года»/«году» → ordinal in that word's case
//!   («2026 года» → «две тысячи двадцать шестого года»).
//!
//! Everything else stays nominative, so «в 405 кабинете» comes out as «в
//! четыреста пять кабинете» — the wrong case, but spoken. Decimals («3,5»)
//! and ranges («10-15») likewise get their digit runs read as separate
//! cardinals rather than as «три целых пять десятых». That trade is
//! deliberate: a listener recovers from a case error, not from silence.

use std::borrow::Cow;

use crate::tts::token::{for_each_token, split_punct, TokenEvent};

/// Digit runs longer than this read digit-by-digit — at ten digits and up the
/// token is a phone number or an id, which is how a Russian speaker reads it.
const MAX_CARDINAL_DIGITS: usize = 9;

const UNITS: [&str; 20] = [
    "ноль",
    "один",
    "два",
    "три",
    "четыре",
    "пять",
    "шесть",
    "семь",
    "восемь",
    "девять",
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать",
];

const TENS: [&str; 10] = [
    "",
    "",
    "двадцать",
    "тридцать",
    "сорок",
    "пятьдесят",
    "шестьдесят",
    "семьдесят",
    "восемьдесят",
    "девяносто",
];

const HUNDREDS: [&str; 10] = [
    "",
    "сто",
    "двести",
    "триста",
    "четыреста",
    "пятьсот",
    "шестьсот",
    "семьсот",
    "восемьсот",
    "девятьсот",
];

/// Scale words with their three agreement forms (1 / 2-4 / 5+) and the gender
/// the count takes: «одна тысяча», but «один миллион».
const SCALES: [(u64, [&str; 3], bool); 2] = [
    (1_000_000, ["миллион", "миллиона", "миллионов"], false),
    (1_000, ["тысяча", "тысячи", "тысяч"], true),
];

const ORD_UNITS: [&str; 10] = [
    "",
    "первый",
    "второй",
    "третий",
    "четвёртый",
    "пятый",
    "шестой",
    "седьмой",
    "восьмой",
    "девятый",
];

const ORD_TEENS: [&str; 10] = [
    "десятый",
    "одиннадцатый",
    "двенадцатый",
    "тринадцатый",
    "четырнадцатый",
    "пятнадцатый",
    "шестнадцатый",
    "семнадцатый",
    "восемнадцатый",
    "девятнадцатый",
];

const ORD_TENS: [&str; 10] = [
    "",
    "",
    "двадцатый",
    "тридцатый",
    "сороковой",
    "пятидесятый",
    "шестидесятый",
    "семидесятый",
    "восьмидесятый",
    "девяностый",
];

const ORD_HUNDREDS: [&str; 10] = [
    "",
    "сотый",
    "двухсотый",
    "трёхсотый",
    "четырёхсотый",
    "пятисотый",
    "шестисотый",
    "семисотый",
    "восьмисотый",
    "девятисотый",
];

const ORD_THOUSANDS: [&str; 10] = [
    "",
    "тысячный",
    "двухтысячный",
    "трёхтысячный",
    "четырёхтысячный",
    "пятитысячный",
    "шеститысячный",
    "семитысячный",
    "восьмитысячный",
    "девятитысячный",
];

const MONTHS_GENITIVE: [&str; 12] = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
];

#[derive(Clone, Copy)]
enum Case {
    Nom,
    Gen,
    Prep,
}

fn unit_word(n: u64, feminine: bool) -> &'static str {
    match (n, feminine) {
        (1, true) => "одна",
        (2, true) => "две",
        _ => UNITS[n as usize],
    }
}

fn under_1000(n: u64, feminine: bool) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let (h, rest) = (n / 100, n % 100);
    if h > 0 {
        parts.push(HUNDREDS[h as usize]);
    }
    if rest >= 20 {
        parts.push(TENS[(rest / 10) as usize]);
        if rest % 10 > 0 {
            parts.push(unit_word(rest % 10, feminine));
        }
    } else if rest > 0 {
        parts.push(unit_word(rest, feminine));
    }
    parts.join(" ")
}

/// Which of a scale word's three forms agrees with `n` (1 / 2-4 / 5+).
fn agreement(n: u64) -> usize {
    let (tail, last) = (n % 100, n % 10);
    if (11..=14).contains(&tail) {
        2
    } else if last == 1 {
        0
    } else if (2..=4).contains(&last) {
        1
    } else {
        2
    }
}

/// Cardinal in nominative, masculine where gender is free. `run_to_words` caps
/// what reaches here at `MAX_CARDINAL_DIGITS`, which is what keeps the hundreds
/// index in range without a check on every call.
fn cardinal(n: u64) -> String {
    if n == 0 {
        return UNITS[0].to_string();
    }
    let mut parts: Vec<String> = Vec::new();
    let mut rest = n;
    for (scale, forms, feminine) in SCALES {
        let count = rest / scale;
        if count == 0 {
            continue;
        }
        // Years and counts alike say «тысяча девятьсот», never «одна тысяча».
        if !(count == 1 && scale == 1_000) {
            parts.push(under_1000(count, feminine));
        }
        parts.push(forms[agreement(count)].to_string());
        rest %= scale;
    }
    if rest > 0 {
        parts.push(under_1000(rest, false));
    }
    parts.join(" ")
}

/// Decline a masculine nominative ordinal. Only «третий» has a soft stem, and
/// its `-ий` ending is what marks it.
fn inflect(nominative: &str, case: Case) -> String {
    let (hard, soft) = match case {
        Case::Nom => return nominative.to_string(),
        Case::Gen => ("ого", "ьего"),
        Case::Prep => ("ом", "ьем"),
    };
    let ending = if nominative.ends_with("ий") {
        soft
    } else {
        hard
    };
    let mut stem = nominative.to_string();
    stem.pop();
    stem.pop();
    stem + ending
}

/// Compound ordinals inflect only their last component: «две тысячи» stays
/// cardinal, «шестого» carries the case. Returns `None` above 999 999 and for
/// round thousands past 9000, where the compound prefix («двадцатипяти-») is
/// beyond what this module claims to know.
fn ordinal(n: u64, case: Case) -> Option<String> {
    if n == 0 || n > 999_999 {
        return None;
    }
    let with_prefix = |head: u64, last: &str| {
        let last = inflect(last, case);
        if head == 0 {
            last
        } else {
            format!("{} {last}", cardinal(head))
        }
    };

    let tail = n % 100;
    if tail != 0 {
        return Some(if tail < 10 {
            with_prefix(n - tail, ORD_UNITS[tail as usize])
        } else if tail < 20 {
            with_prefix(n - tail, ORD_TEENS[(tail - 10) as usize])
        } else if tail.is_multiple_of(10) {
            with_prefix(n - tail, ORD_TENS[(tail / 10) as usize])
        } else {
            with_prefix(n - tail % 10, ORD_UNITS[(tail % 10) as usize])
        });
    }
    let hundreds = n % 1000;
    if hundreds != 0 {
        return Some(with_prefix(
            n - hundreds,
            ORD_HUNDREDS[(hundreds / 100) as usize],
        ));
    }
    let thousands = n / 1000;
    (1..=9)
        .contains(&thousands)
        .then(|| inflect(ORD_THOUSANDS[thousands as usize], case))
}

fn as_number(core: &str) -> Option<u64> {
    if core.is_empty() || !core.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // A leading zero means the digits are being read out, not counted.
    if core.len() > 1 && core.starts_with('0') {
        return None;
    }
    core.parse().ok()
}

fn time_words(core: &str) -> Option<String> {
    let (hh, mm) = core.split_once(':')?;
    if !(1..=2).contains(&hh.len()) || mm.len() != 2 {
        return None;
    }
    let valid = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !valid(hh) || !valid(mm) {
        return None;
    }
    let (h, m): (u64, u64) = (hh.parse().ok()?, mm.parse().ok()?);
    if h > 23 || m > 59 {
        return None;
    }
    let minutes = if m == 0 {
        format!("{} {}", UNITS[0], UNITS[0])
    } else if m < 10 {
        format!("{} {}", UNITS[0], cardinal(m))
    } else {
        cardinal(m)
    };
    Some(format!("{} {minutes}", cardinal(h)))
}

/// The two contexts where the case is legible from the next word alone.
fn contextual(core: &str, next: Option<&str>) -> Option<String> {
    let n = as_number(core)?;
    let next = split_punct(next?).1.to_lowercase();
    if (1..=31).contains(&n) && MONTHS_GENITIVE.contains(&next.as_str()) {
        return ordinal(n, Case::Gen);
    }
    let case = match next.as_str() {
        "год" => Case::Nom,
        "года" => Case::Gen,
        "году" => Case::Prep,
        _ => return None,
    };
    ordinal(n, case)
}

fn run_to_words(run: &str) -> String {
    if run.len() <= MAX_CARDINAL_DIGITS {
        if let Some(n) = as_number(run) {
            return cardinal(n);
        }
    }
    run.chars()
        .map(|c| UNITS[(c as u8 - b'0') as usize])
        .collect::<Vec<_>>()
        .join(" ")
}

/// Fallback for tokens no pattern claimed: every maximal digit run becomes
/// words in place, so «10-15» reads «десять-пятнадцать» and no digit survives.
fn digit_runs_to_words(s: &str) -> Cow<'_, str> {
    if !s.bytes().any(|b| b.is_ascii_digit()) {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() * 4);
    let mut run = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            run.push(c);
            continue;
        }
        if !run.is_empty() {
            out.push_str(&run_to_words(&run));
            run.clear();
        }
        out.push(c);
    }
    if !run.is_empty() {
        out.push_str(&run_to_words(&run));
    }
    Cow::Owned(out)
}

fn verbalize_token(token: &str, next: Option<&str>) -> String {
    let (head, core, tail) = split_punct(token);
    let spoken = time_words(core)
        .or_else(|| contextual(core, next))
        .unwrap_or_else(|| digit_runs_to_words(core).into_owned());
    format!("{head}{spoken}{tail}")
}

enum Piece {
    Token(String),
    Gap(char),
}

/// Rewrite every number in `text` to the words Vosk can actually pronounce.
pub(super) fn verbalize(text: &str) -> String {
    let mut pieces: Vec<Piece> = Vec::new();
    for_each_token(text, |ev| {
        pieces.push(match ev {
            TokenEvent::Token(t) => Piece::Token(t.to_string()),
            TokenEvent::Gap(c) => Piece::Gap(c),
        })
    });

    let mut out = String::with_capacity(text.len() * 2);
    for (i, piece) in pieces.iter().enumerate() {
        match piece {
            Piece::Gap(c) => out.push(*c),
            Piece::Token(tok) => {
                let next = pieces[i + 1..].iter().find_map(|p| match p {
                    Piece::Token(t) => Some(t.as_str()),
                    Piece::Gap(_) => None,
                });
                out.push_str(&verbalize_token(tok, next));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cardinals_cover_each_positional_shape() {
        assert_eq!(cardinal(0), "ноль");
        assert_eq!(cardinal(5), "пять");
        assert_eq!(cardinal(14), "четырнадцать");
        assert_eq!(cardinal(30), "тридцать");
        assert_eq!(cardinal(45), "сорок пять");
        assert_eq!(cardinal(100), "сто");
        assert_eq!(cardinal(405), "четыреста пять");
        assert_eq!(cardinal(999), "девятьсот девяносто девять");
    }

    #[test]
    fn scale_words_agree_with_their_count() {
        assert_eq!(cardinal(1_000), "тысяча");
        assert_eq!(cardinal(2_000), "две тысячи");
        assert_eq!(cardinal(5_000), "пять тысяч");
        assert_eq!(cardinal(11_000), "одиннадцать тысяч");
        assert_eq!(cardinal(21_000), "двадцать одна тысяча");
        assert_eq!(cardinal(1_000_000), "один миллион");
        assert_eq!(cardinal(2_000_000), "два миллиона");
        assert_eq!(cardinal(1_999), "тысяча девятьсот девяносто девять");
    }

    #[test]
    fn ordinals_decline_only_their_last_component() {
        assert_eq!(
            ordinal(2026, Case::Gen).unwrap(),
            "две тысячи двадцать шестого"
        );
        assert_eq!(
            ordinal(2026, Case::Nom).unwrap(),
            "две тысячи двадцать шестой"
        );
        assert_eq!(
            ordinal(2026, Case::Prep).unwrap(),
            "две тысячи двадцать шестом"
        );
        assert_eq!(ordinal(2015, Case::Gen).unwrap(), "две тысячи пятнадцатого");
        assert_eq!(
            ordinal(1999, Case::Prep).unwrap(),
            "тысяча девятьсот девяносто девятом"
        );
        assert_eq!(ordinal(2000, Case::Prep).unwrap(), "двухтысячном");
        assert_eq!(ordinal(1900, Case::Gen).unwrap(), "тысяча девятисотого");
        assert_eq!(ordinal(40, Case::Gen).unwrap(), "сорокового");
    }

    #[test]
    fn third_takes_the_soft_stem() {
        assert_eq!(ordinal(3, Case::Nom).unwrap(), "третий");
        assert_eq!(ordinal(3, Case::Gen).unwrap(), "третьего");
        assert_eq!(ordinal(3, Case::Prep).unwrap(), "третьем");
        assert_eq!(ordinal(23, Case::Gen).unwrap(), "двадцать третьего");
    }

    #[test]
    fn ordinal_declines_the_boundary_it_documents() {
        // Round thousands past 9000 need a compound prefix this module does not
        // claim; the caller falls back to a nominative cardinal.
        assert_eq!(ordinal(9_000, Case::Gen).unwrap(), "девятитысячного");
        assert!(ordinal(10_000, Case::Gen).is_none());
        assert!(ordinal(0, Case::Gen).is_none());
    }

    #[test]
    fn dates_take_the_genitive_from_the_month() {
        assert_eq!(verbalize("25 декабря"), "двадцать пятого декабря");
        assert_eq!(verbalize("1 мая"), "первого мая");
        assert_eq!(verbalize("3 марта"), "третьего марта");
        // Out of day range: no month agreement to borrow, stays cardinal.
        assert_eq!(verbalize("40 декабря"), "сорок декабря");
    }

    #[test]
    fn years_take_the_case_the_following_word_carries() {
        assert_eq!(verbalize("2026 года"), "две тысячи двадцать шестого года");
        assert_eq!(
            verbalize("в 2026 году"),
            "в две тысячи двадцать шестом году"
        );
        assert_eq!(verbalize("2026 год"), "две тысячи двадцать шестой год");
        // Punctuation on the context word must not hide it.
        assert_eq!(verbalize("2026 года,"), "две тысячи двадцать шестого года,");
    }

    #[test]
    fn times_read_as_hour_then_minute() {
        assert_eq!(verbalize("14:30"), "четырнадцать тридцать");
        assert_eq!(verbalize("в 14:00"), "в четырнадцать ноль ноль");
        assert_eq!(verbalize("09:05"), "девять ноль пять");
        // Not a clock time — falls back to reading both runs.
        assert_eq!(verbalize("25:99"), "двадцать пять:девяносто девять");
    }

    #[test]
    fn bare_numbers_stay_nominative() {
        assert_eq!(verbalize("Кабинет 405."), "Кабинет четыреста пять.");
        assert_eq!(verbalize("«405»"), "«четыреста пять»");
        // The documented wrong-case case: nominative inside a prepositional phrase.
        assert_eq!(verbalize("в 405 кабинете"), "в четыреста пять кабинете");
    }

    #[test]
    fn digit_runs_inside_a_token_are_read_in_place() {
        assert_eq!(verbalize("10-15"), "десять-пятнадцать");
        assert_eq!(verbalize("3,5"), "три,пять");
        assert_eq!(verbalize("№7"), "№семь");
    }

    #[test]
    fn long_and_zero_led_runs_read_digit_by_digit() {
        assert_eq!(verbalize("007"), "ноль ноль семь");
        assert_eq!(
            verbalize("1234567890"),
            "один два три четыре пять шесть семь восемь девять ноль"
        );
        assert_eq!(cardinal(999_999_999), run_to_words("999999999"));
    }

    #[test]
    fn text_without_digits_round_trips() {
        let text = "Встреча  назначена\tна завтра.\n";
        assert_eq!(verbalize(text), text);
        assert_eq!(verbalize(""), "");
    }
}

//! English currency and comma-grouped amounts, verbalized before any English engine sees them: both Kokoro G2Ps drop the sign and lose `$1,234.56` entirely, while bare integers, years and ordinals round-trip today and are deliberately left alone.

use std::borrow::Cow;

const ONES: [&str; 20] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];

const TENS: [&str; 10] = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

const SCALES: [(u64, &str); 4] = [
    (1_000_000_000_000, "trillion"),
    (1_000_000_000, "billion"),
    (1_000_000, "million"),
    (1_000, "thousand"),
];

/// Above this the scale table runs out, so the token is left for the G2P.
const MAX_CARDINAL: u64 = 999_999_999_999_999;

/// `(sign, major singular, major plural, minor singular, minor plural)`.
const CURRENCIES: [(char, &str, &str, &str, &str); 3] = [
    ('$', "dollar", "dollars", "cent", "cents"),
    ('€', "euro", "euros", "cent", "cents"),
    ('£', "pound", "pounds", "penny", "pence"),
];

fn under_hundred(n: u64) -> String {
    if n < 20 {
        return ONES[n as usize].to_string();
    }
    let (t, r) = (n / 10, n % 10);
    if r == 0 {
        TENS[t as usize].to_string()
    } else {
        // A hyphenated compound loses its second half in FluidAudio's G2P ("fifty-six" reads as "fifty").
        format!("{} {}", TENS[t as usize], ONES[r as usize])
    }
}

fn under_thousand(n: u64) -> String {
    if n < 100 {
        return under_hundred(n);
    }
    let (h, r) = (n / 100, n % 100);
    if r == 0 {
        format!("{} hundred", ONES[h as usize])
    } else {
        format!("{} hundred {}", ONES[h as usize], under_hundred(r))
    }
}

/// American reading: no "and" between the hundreds and the tens.
fn cardinal(n: u64) -> String {
    if n < 1_000 {
        return under_thousand(n);
    }
    let mut parts = Vec::new();
    let mut rest = n;
    for (value, name) in SCALES {
        if rest >= value {
            parts.push(format!("{} {name}", under_thousand(rest / value)));
            rest %= value;
        }
    }
    if rest > 0 {
        parts.push(under_thousand(rest));
    }
    parts.join(" ")
}

fn digits_spelled(digits: &str) -> String {
    digits
        .chars()
        .map(|c| ONES[(c as u8 - b'0') as usize])
        .collect::<Vec<_>>()
        .join(" ")
}

struct Amount {
    whole: u64,
    fraction: Option<String>,
    /// Bytes consumed from the start of the number.
    len: usize,
}

/// Read an integer with optional `,` grouping and an optional `.dd` tail.
/// Malformed grouping claims nothing: `1,23` is likelier a list than a number.
fn read_amount(s: &str, require_comma: bool) -> Option<Amount> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let lead = i;
    let mut digits = s[..i].to_string();
    let mut grouped = false;
    while i + 3 < b.len()
        && b[i] == b','
        && b[i + 1..i + 4].iter().all(u8::is_ascii_digit)
        && (i + 4 >= b.len() || !b[i + 4].is_ascii_digit())
    {
        digits.push_str(&s[i + 1..i + 4]);
        i += 4;
        grouped = true;
    }
    if grouped && lead > 3 {
        return None;
    }
    if i < b.len() && b[i] == b',' && i + 1 < b.len() && b[i + 1].is_ascii_digit() {
        return None;
    }
    if require_comma && !grouped {
        return None;
    }
    let whole: u64 = digits.parse().ok()?;
    if whole > MAX_CARDINAL {
        return None;
    }
    let mut fraction = None;
    if i + 1 < b.len() && b[i] == b'.' && b[i + 1].is_ascii_digit() {
        let start = i + 1;
        let mut j = start;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        fraction = Some(s[start..j].to_string());
        i = j;
    }
    Some(Amount {
        whole,
        fraction,
        len: i,
    })
}

fn money_words(amount: &Amount, units: (&str, &str, &str, &str)) -> String {
    let (major_one, major_many, minor_one, minor_many) = units;
    let major = |n: u64| {
        format!(
            "{} {}",
            cardinal(n),
            if n == 1 { major_one } else { major_many }
        )
    };
    match amount.fraction.as_deref() {
        None => major(amount.whole),
        Some(f) if f.len() == 2 => {
            let cents: u64 = f.parse().unwrap_or(0);
            let minor = format!(
                "{} {}",
                cardinal(cents),
                if cents == 1 { minor_one } else { minor_many }
            );
            match (amount.whole, cents) {
                (_, 0) => major(amount.whole),
                (0, _) => minor,
                _ => format!("{} and {minor}", major(amount.whole)),
            }
        }
        Some(f) => format!(
            "{} point {} {major_many}",
            cardinal(amount.whole),
            digits_spelled(f)
        ),
    }
}

fn plain_words(amount: &Amount) -> String {
    match amount.fraction.as_deref() {
        None => cardinal(amount.whole),
        Some(f) => format!("{} point {}", cardinal(amount.whole), digits_spelled(f)),
    }
}

/// Rewrite currency amounts and comma-grouped numbers in `text` to words.
pub fn verbalize(text: &str) -> Cow<'_, str> {
    if !text.bytes().any(|b| b.is_ascii_digit()) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + 32);
    let mut rest = text;
    let mut prev: Option<char> = None;
    let mut matched = false;
    while let Some(c) = rest.chars().next() {
        let mut claimed = None;
        if let Some((_, m1, mn, n1, nn)) = CURRENCIES.iter().find(|(sign, ..)| *sign == c) {
            if let Some(a) = read_amount(&rest[c.len_utf8()..], false) {
                claimed = Some((money_words(&a, (m1, mn, n1, nn)), c.len_utf8() + a.len));
            }
        }
        // Only at a number's first digit, or a rejected `9,999,999,999,999,999,999` would be re-entered at its next group.
        let at_number_start = claimed.is_none()
            && c.is_ascii_digit()
            && !matches!(prev, Some(p) if p.is_ascii_digit() || p == ',' || p == '.');
        if at_number_start {
            match read_amount(rest, true) {
                Some(a) => claimed = Some((plain_words(&a), a.len)),
                None => {
                    let len = rest
                        .find(|ch: char| !ch.is_ascii_digit() && ch != ',' && ch != '.')
                        .unwrap_or(rest.len());
                    out.push_str(&rest[..len]);
                    prev = rest[..len].chars().last();
                    rest = &rest[len..];
                    continue;
                }
            }
        }
        match claimed {
            Some((words, len)) => {
                out.push_str(&words);
                prev = rest[..len].chars().last();
                rest = &rest[len..];
                matched = true;
            }
            None => {
                out.push(c);
                prev = Some(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    if matched {
        Cow::Owned(out)
    } else {
        Cow::Borrowed(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_currency_amount_carries_its_unit() {
        assert_eq!(verbalize("$5"), "five dollars");
        assert_eq!(verbalize("$1"), "one dollar");
        assert_eq!(
            verbalize("He paid $1234"),
            "He paid one thousand two hundred thirty four dollars"
        );
        assert_eq!(
            verbalize("$1,234.56"),
            "one thousand two hundred thirty four dollars and fifty six cents"
        );
        assert_eq!(verbalize("€20.01"), "twenty euros and one cent");
        assert_eq!(verbalize("£3.50"), "three pounds and fifty pence");
        assert_eq!(verbalize("$0.99"), "ninety nine cents");
        assert_eq!(verbalize("$7.00"), "seven dollars");
    }

    #[test]
    fn a_comma_grouped_number_is_read_without_a_unit() {
        assert_eq!(verbalize("1,234"), "one thousand two hundred thirty four");
        assert_eq!(
            verbalize("2,500,000 people"),
            "two million five hundred thousand people"
        );
        assert_eq!(
            verbalize("1,234.5"),
            "one thousand two hundred thirty four point five"
        );
    }

    #[test]
    fn bare_integers_years_and_ordinals_stay_with_the_g2p() {
        for text in [
            "Room 405",
            "It was 1999.",
            "3rd place",
            "10:05 PM",
            "IPv6",
            "1234",
        ] {
            assert_eq!(verbalize(text), text, "{text:?} must be left alone");
        }
    }

    #[test]
    fn a_malformed_group_or_an_unbounded_number_is_left_alone() {
        for text in ["1,23", "1,2345", "1234,567", "9,999,999,999,999,999,999"] {
            assert_eq!(verbalize(text), text, "{text:?} must be left alone");
        }
    }

    #[test]
    fn surrounding_prose_and_punctuation_survive() {
        assert_eq!(
            verbalize("Of 1,234, about $10 remains."),
            "Of one thousand two hundred thirty four, about ten dollars remains."
        );
    }

    #[test]
    fn text_without_digits_is_returned_borrowed() {
        assert!(matches!(verbalize("Hello world"), Cow::Borrowed(_)));
        assert!(matches!(verbalize("Room 405"), Cow::Borrowed(_)));
    }

    #[test]
    fn cardinals_cover_each_positional_shape() {
        assert_eq!(cardinal(0), "zero");
        assert_eq!(cardinal(19), "nineteen");
        assert_eq!(cardinal(40), "forty");
        assert_eq!(cardinal(405), "four hundred five");
        assert_eq!(cardinal(1_000), "one thousand");
        assert_eq!(cardinal(1_000_000_000), "one billion");
        assert_eq!(
            cardinal(987_654_321),
            "nine hundred eighty seven million six hundred fifty four thousand three hundred twenty one"
        );
    }
}

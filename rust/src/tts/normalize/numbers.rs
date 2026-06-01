//! Per-language integer → words conversion for 0..=999_999.
//!
//! Covers es (Spanish), fr (French), it (Italian), pt (Portuguese).
//! Unknown languages return the digit string unchanged.

// ── Spanish ──────────────────────────────────────────────────────────────────

const ES_UNITS: [&str; 20] = [
    "cero",
    "uno",
    "dos",
    "tres",
    "cuatro",
    "cinco",
    "seis",
    "siete",
    "ocho",
    "nueve",
    "diez",
    "once",
    "doce",
    "trece",
    "catorce",
    "quince",
    "dieciséis",
    "diecisiete",
    "dieciocho",
    "diecinueve",
];
const ES_TENS: [&str; 10] = [
    "",
    "",
    "veinte",
    "treinta",
    "cuarenta",
    "cincuenta",
    "sesenta",
    "setenta",
    "ochenta",
    "noventa",
];
const ES_HUNDREDS: [&str; 10] = [
    "",
    "ciento",
    "doscientos",
    "trescientos",
    "cuatrocientos",
    "quinientos",
    "seiscientos",
    "setecientos",
    "ochocientos",
    "novecientos",
];

fn es_under_1000(n: u32) -> String {
    if n >= 1000 {
        return n.to_string();
    }
    if n == 100 {
        return "cien".into();
    }
    let (h, r) = (n / 100, n % 100);
    let mut parts: Vec<String> = Vec::new();
    if h > 0 {
        parts.push(ES_HUNDREDS[h as usize].to_string());
    }
    if r < 20 {
        if r > 0 || n == 0 {
            parts.push(ES_UNITS[r as usize].into());
        }
    } else if r < 30 {
        // 21-29: veinti + unit (no space)
        parts.push(format!("veinti{}", ES_UNITS[(r - 20) as usize]));
    } else {
        let (t, u) = (r / 10, r % 10);
        parts.push(ES_TENS[t as usize].into());
        if u > 0 {
            parts.push(format!("y {}", ES_UNITS[u as usize]));
        }
    }
    parts.join(" ")
}

fn es_words(n: u32) -> String {
    if n == 0 {
        return "cero".into();
    }
    let (thousands, rem) = (n / 1000, n % 1000);
    let mut parts: Vec<String> = Vec::new();
    if thousands > 0 {
        if thousands == 1 {
            parts.push("mil".into());
        } else {
            parts.push(format!("{} mil", es_under_1000(thousands)));
        }
    }
    if rem > 0 {
        parts.push(es_under_1000(rem));
    }
    parts.join(" ")
}

// ── French ────────────────────────────────────────────────────────────────────

const FR_UNITS: [&str; 20] = [
    "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze",
    "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf",
];
const FR_TENS: [&str; 10] = [
    "",
    "",
    "vingt",
    "trente",
    "quarante",
    "cinquante",
    "soixante",
    "soixante",
    "quatre-vingt",
    "quatre-vingt",
];

fn fr_under_100(n: u32) -> String {
    if n >= 100 {
        return n.to_string();
    }
    if n < 20 {
        return FR_UNITS[n as usize].into();
    }
    match n {
        // 80 = quatre-vingts (with trailing s when standalone)
        80 => "quatre-vingts".into(),
        // 81-89 = quatre-vingt-X (no trailing s)
        81..=89 => format!("quatre-vingt-{}", FR_UNITS[(n - 80) as usize]),
        // 70-79 = soixante + 10..19
        70..=79 => {
            let sub = FR_UNITS[(n - 60) as usize];
            format!("soixante-{sub}")
        }
        // 90-99 = quatre-vingt + 10..19
        90..=99 => {
            let sub = FR_UNITS[(n - 80) as usize];
            format!("quatre-vingt-{sub}")
        }
        _ => {
            let (t, u) = (n / 10, n % 10);
            let tens = FR_TENS[t as usize];
            if u == 0 {
                tens.into()
            } else if u == 1 && t < 8 {
                // et un for tens 2-7 (not 80s)
                format!("{tens}-et-un")
            } else {
                format!("{}-{}", tens, FR_UNITS[u as usize])
            }
        }
    }
}

fn fr_under_1000(n: u32) -> String {
    if n >= 1000 {
        return n.to_string();
    }
    if n == 0 {
        return String::new();
    }
    let (h, r) = (n / 100, n % 100);
    if h == 0 {
        return fr_under_100(r);
    }
    let cent = if h == 1 {
        "cent".to_string()
    } else {
        // plural cent only when no remainder
        if r == 0 {
            format!("{} cents", FR_UNITS[h as usize])
        } else {
            format!("{} cent", FR_UNITS[h as usize])
        }
    };
    if r == 0 {
        cent
    } else {
        format!("{cent} {}", fr_under_100(r))
    }
}

fn fr_words(n: u32) -> String {
    if n == 0 {
        return "zéro".into();
    }
    let (thousands, rem) = (n / 1000, n % 1000);
    let mut parts: Vec<String> = Vec::new();
    if thousands > 0 {
        if thousands == 1 {
            parts.push("mille".into());
        } else {
            parts.push(format!("{} mille", fr_under_1000(thousands)));
        }
    }
    if rem > 0 {
        parts.push(fr_under_1000(rem));
    }
    parts.join(" ")
}

// ── Italian ───────────────────────────────────────────────────────────────────

const IT_UNITS: [&str; 20] = [
    "zero",
    "uno",
    "due",
    "tre",
    "quattro",
    "cinque",
    "sei",
    "sette",
    "otto",
    "nove",
    "dieci",
    "undici",
    "dodici",
    "tredici",
    "quattordici",
    "quindici",
    "sedici",
    "diciassette",
    "diciotto",
    "diciannove",
];

// Italian tens (20, 30, ..., 90)
const IT_TENS: [&str; 10] = [
    "",
    "",
    "venti",
    "trenta",
    "quaranta",
    "cinquanta",
    "sessanta",
    "settanta",
    "ottanta",
    "novanta",
];

const IT_HUNDREDS: [&str; 10] = [
    "",
    "cento",
    "duecento",
    "trecento",
    "quattrocento",
    "cinquecento",
    "seicento",
    "settecento",
    "ottocento",
    "novecento",
];

fn it_under_100(n: u32) -> String {
    if n >= 100 {
        return n.to_string();
    }
    if n < 20 {
        return IT_UNITS[n as usize].into();
    }
    let (t, u) = (n / 10, n % 10);
    let tens_str = IT_TENS[t as usize];
    if u == 0 {
        tens_str.into()
    } else {
        // Elision: drop trailing vowel of tens before uno (1) or otto (8)
        let unit_str = IT_UNITS[u as usize];
        if u == 1 || u == 8 {
            // Strip trailing vowel from tens word
            let trimmed = tens_str.trim_end_matches(['a', 'i', 'o']);
            format!("{trimmed}{unit_str}")
        } else {
            format!("{tens_str}{unit_str}")
        }
    }
}

fn it_under_1000(n: u32) -> String {
    if n >= 1000 {
        return n.to_string();
    }
    if n == 0 {
        return String::new();
    }
    let (h, r) = (n / 100, n % 100);
    if h == 0 {
        return it_under_100(r);
    }
    let hundreds = IT_HUNDREDS[h as usize];
    if r == 0 {
        hundreds.into()
    } else {
        // hundreds and remainder are separated by a space in Italian
        // (e.g. "cinquecento dodici", "trecento ventuno")
        format!("{hundreds} {}", it_under_100(r))
    }
}

fn it_words(n: u32) -> String {
    if n == 0 {
        return "zero".into();
    }
    let (thousands, rem) = (n / 1000, n % 1000);
    let mut parts: Vec<String> = Vec::new();
    if thousands > 0 {
        if thousands == 1 {
            parts.push("mille".into());
        } else {
            parts.push(format!("{}mila", it_under_1000(thousands)));
        }
    }
    if rem > 0 {
        parts.push(it_under_1000(rem));
    }
    parts.join("")
}

// ── Portuguese ────────────────────────────────────────────────────────────────

const PT_UNITS: [&str; 20] = [
    "zero",
    "um",
    "dois",
    "três",
    "quatro",
    "cinco",
    "seis",
    "sete",
    "oito",
    "nove",
    "dez",
    "onze",
    "doze",
    "treze",
    "catorze",
    "quinze",
    "dezasseis",
    "dezassete",
    "dezoito",
    "dezanove",
];

const PT_TENS: [&str; 10] = [
    "",
    "",
    "vinte",
    "trinta",
    "quarenta",
    "cinquenta",
    "sessenta",
    "setenta",
    "oitenta",
    "noventa",
];

const PT_HUNDREDS: [&str; 10] = [
    "",
    "cem",
    "duzentos",
    "trezentos",
    "quatrocentos",
    "quinhentos",
    "seiscentos",
    "setecentos",
    "oitocentos",
    "novecentos",
];

fn pt_under_100(n: u32) -> String {
    if n >= 100 {
        return n.to_string();
    }
    if n < 20 {
        return PT_UNITS[n as usize].into();
    }
    let (t, u) = (n / 10, n % 10);
    let tens = PT_TENS[t as usize];
    if u == 0 {
        tens.into()
    } else {
        format!("{tens} e {}", PT_UNITS[u as usize])
    }
}

fn pt_under_1000(n: u32) -> String {
    if n >= 1000 {
        return n.to_string();
    }
    if n == 0 {
        return String::new();
    }
    let (h, r) = (n / 100, n % 100);
    if h == 0 {
        return pt_under_100(r);
    }
    // 100 = cem; 101-199 = cento e ...
    let hundreds = if h == 1 {
        if r == 0 {
            "cem".to_string()
        } else {
            "cento".to_string()
        }
    } else {
        PT_HUNDREDS[h as usize].to_string()
    };
    if r == 0 {
        hundreds
    } else {
        format!("{hundreds} e {}", pt_under_100(r))
    }
}

fn pt_words(n: u32) -> String {
    if n == 0 {
        return "zero".into();
    }
    let (thousands, rem) = (n / 1000, n % 1000);
    let mut parts: Vec<String> = Vec::new();
    if thousands > 0 {
        if thousands == 1 {
            parts.push("mil".into());
        } else {
            parts.push(format!("{} mil", pt_under_1000(thousands)));
        }
    }
    if rem > 0 {
        parts.push(pt_under_1000(rem));
    }
    parts.join(" e ")
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Convert an integer `n` to its spoken-word form in the given language.
///
/// Supported: `"es"` (Spanish), `"fr"` (French), `"it"` (Italian),
/// `"pt"` (Portuguese). Unknown languages return the digit string.
pub fn to_words(n: u32, lang: &str) -> String {
    match lang {
        "es" => es_words(n),
        "fr" => fr_words(n),
        "it" => it_words(n),
        "pt" => pt_words(n),
        _ => n.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_numbers_do_not_panic() {
        // Beyond the 0..=999_999 support band — must NOT panic; return *something* safe.
        for lang in ["es", "fr", "it", "pt"] {
            let _ = to_words(1_000_000, lang);
            let _ = to_words(u32::MAX, lang);
        }
    }

    #[test]
    fn spanish_integers() {
        assert_eq!(to_words(27, "es"), "veintisiete");
        assert_eq!(to_words(512, "es"), "quinientos doce");
        assert_eq!(to_words(936, "es"), "novecientos treinta y seis");
        assert_eq!(to_words(100, "es"), "cien");
    }

    #[test]
    fn italian_integers() {
        assert_eq!(to_words(512, "it"), "cinquecento dodici");
        assert_eq!(to_words(21, "it"), "ventuno");
    }

    #[test]
    fn portuguese_integers() {
        assert_eq!(to_words(936, "pt"), "novecentos e trinta e seis");
    }

    #[test]
    fn french_integers() {
        assert_eq!(to_words(348, "fr"), "trois cent quarante-huit");
        assert_eq!(to_words(80, "fr"), "quatre-vingts");
    }
}

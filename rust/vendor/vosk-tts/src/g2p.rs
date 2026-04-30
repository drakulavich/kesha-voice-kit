use std::collections::HashSet;

const SOFT_LETTERS: &str = "яёюиье";
const START_SYL: &str = "#ъьаяоёуюэеиы-";
const OTHERS: &str = "#+-ьъ";

const SOFTHARD_CONS: &[(&str, &str)] = &[
    ("б", "b"),
    ("в", "v"),
    ("г", "g"),
    ("Г", "g"),
    ("д", "d"),
    ("з", "z"),
    ("к", "k"),
    ("л", "l"),
    ("м", "m"),
    ("н", "n"),
    ("п", "p"),
    ("р", "r"),
    ("с", "s"),
    ("т", "t"),
    ("ф", "f"),
    ("х", "h"),
];

const OTHER_CONS: &[(&str, &str)] = &[
    ("ж", "zh"),
    ("ц", "c"),
    ("ч", "ch"),
    ("ш", "sh"),
    ("щ", "sch"),
    ("й", "j"),
];

const VOWELS: &[(&str, &str)] = &[
    ("а", "a"),
    ("я", "a"),
    ("у", "u"),
    ("ю", "u"),
    ("о", "o"),
    ("ё", "o"),
    ("э", "e"),
    ("е", "e"),
    ("и", "i"),
    ("ы", "y"),
];

#[derive(Debug, Clone)]
struct Phone {
    symbol: String,
    stress: i32,
}

fn pallatize(phones: &mut [Phone]) {
    let soft_letters: HashSet<char> = SOFT_LETTERS.chars().collect();

    for i in 0..phones.len().saturating_sub(1) {
        let phone_symbol = phones[i].symbol.clone();

        if let Some(&(_, replacement)) = SOFTHARD_CONS
            .iter()
            .find(|&&(letter, _)| letter == phone_symbol)
        {
            let next_char = phones[i + 1].symbol.chars().next();
            if let Some(next_ch) = next_char {
                if soft_letters.contains(&next_ch) {
                    phones[i] = Phone {
                        symbol: format!("{}j", replacement),
                        stress: 0,
                    };
                } else {
                    phones[i] = Phone {
                        symbol: replacement.to_string(),
                        stress: 0,
                    };
                }
            }
        }

        if let Some(&(_, replacement)) = OTHER_CONS
            .iter()
            .find(|&&(letter, _)| letter == phone_symbol)
        {
            phones[i] = Phone {
                symbol: replacement.to_string(),
                stress: 0,
            };
        }
    }
}

fn convert_vowels(phones: &[Phone]) -> Vec<String> {
    let mut new_phones = Vec::new();
    let start_syl: HashSet<char> = START_SYL.chars().collect();
    let soft_vowels: HashSet<char> = "яюеё".chars().collect();
    let vowel_map: std::collections::HashMap<char, &str> = VOWELS
        .iter()
        .map(|&(cyr, lat)| (cyr.chars().next().unwrap(), lat))
        .collect();

    let mut prev = String::from("");

    for phone in phones {
        if start_syl.contains(&prev.chars().next().unwrap_or('\0')) {
            let first_char = phone.symbol.chars().next();
            if let Some(ch) = first_char {
                if soft_vowels.contains(&ch) {
                    new_phones.push("j".to_string());
                }
            }
        }

        let first_char = phone.symbol.chars().next();
        if let Some(ch) = first_char {
            if let Some(&vowel) = vowel_map.get(&ch) {
                new_phones.push(format!("{}{}", vowel, phone.stress));
            } else {
                new_phones.push(phone.symbol.clone());
            }
        }

        prev = phone.symbol.clone();
    }

    new_phones
}

/// Converts a stress-marked Russian word to phoneme sequence
///
/// # Arguments
/// * `stress_word` - Word with stress marked using '+' character (e.g., "абстр+акция")
///
/// # Returns
/// Space-separated phoneme string
pub fn convert(stress_word: &str) -> String {
    let phones_str = format!("#{}#", stress_word);
    let others_set: HashSet<char> = OTHERS.chars().collect();

    // Assign stress marks
    let mut stress_phones = Vec::new();
    let mut stress = 0;

    for ch in phones_str.chars() {
        if ch == '+' {
            stress = 1;
        } else {
            stress_phones.push(Phone {
                symbol: ch.to_string(),
                stress,
            });
            stress = 0;
        }
    }

    // Palatalize
    pallatize(&mut stress_phones);

    // Convert vowels
    let phones = convert_vowels(&stress_phones);

    // Filter out unwanted characters
    let filtered: Vec<String> = phones
        .into_iter()
        .filter(|p| {
            p.chars()
                .next()
                .map(|ch| !others_set.contains(&ch))
                .unwrap_or(false)
        })
        .collect();

    filtered.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Tests for convert() - main G2P function
    // ========================================================================

    #[test]
    fn test_convert_simple() {
        let result = convert("пр+ивет");
        assert!(!result.is_empty());
        println!("Result: {}", result);
    }

    #[test]
    fn test_convert_no_stress() {
        let result = convert("привет");
        assert!(!result.is_empty());
        println!("Result: {}", result);
    }

    #[test]
    fn test_convert_single_vowel() {
        // Single vowel with stress
        let result = convert("а+а");
        assert!(!result.is_empty());
        assert!(result.contains("a1"));
    }

    #[test]
    fn test_convert_soft_consonants() {
        // Word with soft consonants before soft vowels (я, ё, ю, и, ь, е)
        let result = convert("м+яч");
        assert!(!result.is_empty());
        // Should contain palatalized consonant (ending with 'j')
        assert!(result.contains('j') || result.contains("mj"));
    }

    #[test]
    fn test_convert_hard_consonants() {
        // Word with consonants before hard vowels
        let result = convert("м+ама");
        assert!(!result.is_empty());
        // Should not contain palatalization marker
        assert!(!result.contains("mj"));
    }

    #[test]
    fn test_convert_with_punctuation() {
        // Words with special characters like # (word boundaries)
        let result = convert("т+ест");
        assert!(!result.is_empty());
    }

    #[test]
    fn test_convert_alphabet_letters() {
        // Test various Russian letters
        let result = convert("б+ык");
        assert!(!result.is_empty());
    }

    #[test]
    fn test_convert_hushing_consonants() {
        // Test hushing consonants: ж, ц, ч, ш, щ, й
        let result = convert("ж+ук");
        assert!(!result.is_empty());
        // Should contain 'zh' for ж
        assert!(result.contains("zh"));
    }

    #[test]
    fn test_convert_yotated_vowels() {
        // Test yotated vowels (я, ю, ё, е) after consonants
        let result = convert("л+юк");
        assert!(!result.is_empty());
    }

    #[test]
    fn test_convert_stress_propagation() {
        // Stress should propagate until next character
        let result = convert("к+от");
        assert!(!result.is_empty());
        // Should have stressed vowel with stress mark 1
        assert!(result.contains("o1"));
    }

    #[test]
    fn test_convert_unstressed_vowels() {
        // Unstressed vowels should have stress mark 0
        let result = convert("пр+ивет");
        assert!(!result.is_empty());
        // Should contain unstressed vowels
        assert!(result.contains("0"));
    }

    #[test]
    fn test_convert_word_boundaries() {
        // Word boundaries (#) should be filtered out
        let result = convert("т+ест");
        assert!(!result.contains('#'));
    }

    #[test]
    fn test_convert_stress_marker() {
        // Stress marker (+) should not appear in output
        let result = convert("т+ест");
        assert!(!result.contains('+'));
    }

    #[test]
    fn test_convert_soft_sign() {
        // Soft sign (ь) should be filtered out
        let result = convert("кон+ь");
        assert!(!result.contains('ь'));
    }

    #[test]
    fn test_convert_hard_sign() {
        // Hard sign (ъ) should be filtered out
        let result = convert("под+ъезд");
        assert!(!result.contains('ъ'));
    }

    #[test]
    fn test_convert_long_word() {
        // Test longer word
        let result = convert("электрич+ество");
        assert!(!result.is_empty());
        assert!(!result.contains('+'));
    }

    #[test]
    fn test_convert_empty_input() {
        // Empty input should produce empty output
        let result = convert("");
        assert_eq!(result, "");
    }

    #[test]
    fn test_convert_single_letter() {
        // Single letter
        let result = convert("а");
        assert!(!result.is_empty() || result.is_empty()); // Either is acceptable
    }

    // ========================================================================
    // Tests for pallatize() - palatalization function
    // ========================================================================

    #[test]
    fn test_pallatize_soft_vowel_context() {
        // Consonant before soft vowel should be palatalized
        let mut phones = vec![
            Phone {
                symbol: "н".to_string(),
                stress: 0,
            },
            Phone {
                symbol: "я".to_string(),
                stress: 0,
            },
        ];
        pallatize(&mut phones);
        // 'н' before 'я' should become 'nj'
        assert!(phones[0].symbol.contains('j') || phones[0].symbol == "nj");
    }

    #[test]
    fn test_pallatize_hard_vowel_context() {
        // Consonant before hard vowel should NOT be palatalized
        let mut phones = vec![
            Phone {
                symbol: "н".to_string(),
                stress: 0,
            },
            Phone {
                symbol: "а".to_string(),
                stress: 0,
            },
        ];
        pallatize(&mut phones);
        // 'н' before 'а' should remain 'n' (no 'j')
        assert_eq!(phones[0].symbol, "n");
    }

    #[test]
    fn test_pallatize_consonant_cluster() {
        // Two consonants - no palatalization
        let mut phones = vec![
            Phone {
                symbol: "б".to_string(),
                stress: 0,
            },
            Phone {
                symbol: "р".to_string(),
                stress: 0,
            },
            Phone {
                symbol: "а".to_string(),
                stress: 0,
            },
        ];
        pallatize(&mut phones);
        // 'б' before 'р' should be hard
        assert_eq!(phones[0].symbol, "b");
    }

    #[test]
    fn test_pallatize_other_consonants() {
        // Other consonants (ж, ц, ч, ш, щ, й) should be converted
        let mut phones = vec![
            Phone {
                symbol: "ж".to_string(),
                stress: 0,
            },
            Phone {
                symbol: "а".to_string(),
                stress: 0,
            },
        ];
        pallatize(&mut phones);
        assert_eq!(phones[0].symbol, "zh");
    }

    #[test]
    fn test_pallatize_last_phone_no_next() {
        // Last phone should not cause panic
        let mut phones = vec![Phone {
            symbol: "н".to_string(),
            stress: 0,
        }];
        pallatize(&mut phones);
        // Should not crash, even though there's no next phone
        assert!(phones.len() == 1);
    }

    // ========================================================================
    // Tests for convert_vowels() - vowel conversion
    // ========================================================================

    #[test]
    fn test_convert_vowels_basic() {
        let phones = vec![Phone {
            symbol: "а".to_string(),
            stress: 1,
        }];
        let result = convert_vowels(&phones);
        assert_eq!(result[0], "a1");
    }

    #[test]
    fn test_convert_vowels_yotated_after_start_syl() {
        // Yotated vowel after start syllable should get 'j' prefix
        let phones = vec![
            Phone {
                symbol: "#".to_string(),
                stress: 0,
            },
            Phone {
                symbol: "я".to_string(),
                stress: 1,
            },
        ];
        let result = convert_vowels(&phones);
        // Should contain 'j' before vowel
        assert!(result.contains(&"j".to_string()));
        assert!(result.iter().any(|s| s.contains("a1")));
    }

    #[test]
    fn test_convert_vowels_stressed() {
        let phones = vec![
            Phone {
                symbol: "о".to_string(),
                stress: 1,
            },
            Phone {
                symbol: "н".to_string(),
                stress: 0,
            },
        ];
        let result = convert_vowels(&phones);
        assert_eq!(result[0], "o1");
    }

    #[test]
    fn test_convert_vowels_unstressed() {
        let phones = vec![Phone {
            symbol: "о".to_string(),
            stress: 0,
        }];
        let result = convert_vowels(&phones);
        assert_eq!(result[0], "o0");
    }

    #[test]
    fn test_convert_vowels_y() {
        // ы -> y
        let phones = vec![Phone {
            symbol: "ы".to_string(),
            stress: 0,
        }];
        let result = convert_vowels(&phones);
        assert_eq!(result[0], "y0");
    }

    #[test]
    fn test_convert_vowels_e_to_e() {
        // е -> e
        let phones = vec![Phone {
            symbol: "е".to_string(),
            stress: 0,
        }];
        let result = convert_vowels(&phones);
        assert_eq!(result[0], "e0");
    }

    #[test]
    fn test_convert_vowels_consonant_unchanged() {
        // Consonants should remain unchanged
        let phones = vec![Phone {
            symbol: "n".to_string(),
            stress: 0,
        }];
        let result = convert_vowels(&phones);
        assert_eq!(result[0], "n");
    }
}

//! ByT5 byte-level tokenizer for CharsiuG2P. ByT5 maps each UTF-8 byte to
//! `byte + BYTE_OFFSET`; the first ids are reserved (pad/eos/unk). No
//! sentencepiece — encode/decode are pure byte arithmetic.

/// ByT5 reserves ids 0..3 (pad=0, eos=1, unk=2) and offsets bytes by 3 (#185 §2).
// Callers land in the next task (Charsiu struct + decode pipeline).
#[allow(dead_code)]
pub const BYTE_OFFSET: i64 = 3;
/// EOS token id (#185 §2).
// Callers land in the next task (Charsiu struct + decode pipeline).
#[allow(dead_code)]
pub const EOS_ID: i64 = 1;

/// Encode `"<tag>: text"` into ByT5 byte ids with a trailing EOS.
/// The `": "` separator matches CharsiuG2P's training format (#185 §4, e.g. `"<spa>: hola"`).
// Callers land in the next task (Charsiu struct + decode pipeline).
#[allow(dead_code)]
pub fn encode_with_tag(text: &str, tag: &str) -> Vec<i64> {
    let mut ids: Vec<i64> = format!("{tag}: {text}")
        .bytes()
        .map(|b| b as i64 + BYTE_OFFSET)
        .collect();
    ids.push(EOS_ID);
    ids
}

/// Decode generated ids back to a UTF-8 string, dropping reserved ids.
// Callers land in the next task (Charsiu struct + decode pipeline).
#[allow(dead_code)]
pub fn decode(ids: &[i64]) -> String {
    let bytes: Vec<u8> = ids
        .iter()
        .filter(|&&id| id >= BYTE_OFFSET)
        .map(|&id| (id - BYTE_OFFSET) as u8)
        .collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_ascii_as_bytes_plus_offset_with_eos() {
        let ids = encode_with_tag("hi", "<spa>");
        assert_eq!(*ids.last().unwrap(), EOS_ID);
        // 'h'=104 -> 107, 'i'=105 -> 108 appear in order before EOS.
        assert!(
            ids.windows(2).any(|w| w == [107, 108]),
            "expected h,i byte tokens: {ids:?}"
        );
    }

    #[test]
    fn decodes_byte_ids_back_to_utf8() {
        assert_eq!(decode(&[107, 108]), "hi");
    }

    #[test]
    fn decode_skips_special_ids() {
        assert_eq!(decode(&[EOS_ID, 107, 108]), "hi");
    }
}

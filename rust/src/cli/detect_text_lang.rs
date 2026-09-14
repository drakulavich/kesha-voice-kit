use anyhow::Result;
use std::io::Read;

use crate::text_lang;

/// Four bytes per character bounds what the CLI's 5000-character limit can send; more is refused, not buffered.
const MAX_STDIN_BYTES: u64 = crate::tts::MAX_TEXT_CHARS as u64 * 4;

pub fn run(text: Option<String>) -> Result<()> {
    let text = match text {
        Some(text) => text,
        None => read_all(&mut std::io::stdin().lock())?,
    };
    if text.trim().is_empty() {
        anyhow::bail!("detect-text-lang requires non-empty text");
    }
    let result = text_lang::detect_text_language(&text)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

/// The caller sends the text on stdin: a NUL byte or a megabyte of it cannot be an argv element.
fn read_all(reader: &mut impl Read) -> Result<String> {
    let mut buf = Vec::new();
    reader.take(MAX_STDIN_BYTES + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > MAX_STDIN_BYTES {
        crate::coded_bail!(
            crate::errors::ErrorCode::TextTooLong,
            "detect-text-lang: stdin exceeds {MAX_STDIN_BYTES} bytes ({} characters at most)",
            crate::tts::MAX_TEXT_CHARS
        );
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::{code_of, ErrorCode};

    /// Serves `a` up to `limit` bytes, then fails: a reader that is not bounded by the caller trips it.
    struct Fuse {
        served: u64,
        limit: u64,
    }

    impl Read for Fuse {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.served >= self.limit {
                return Err(std::io::Error::other("read past the fuse"));
            }
            let n = buf.len().min((self.limit - self.served) as usize);
            buf[..n].fill(b'a');
            self.served += n as u64;
            Ok(n)
        }
    }

    #[test]
    fn stdin_within_the_limit_is_read_whole() {
        let mut reader = std::io::Cursor::new(vec![b'a'; MAX_STDIN_BYTES as usize]);
        assert_eq!(
            read_all(&mut reader).unwrap().len(),
            MAX_STDIN_BYTES as usize
        );
    }

    #[test]
    fn stdin_past_the_limit_is_too_long_and_is_not_buffered_to_eof() {
        let mut reader = Fuse {
            served: 0,
            limit: MAX_STDIN_BYTES + 4096,
        };
        let err = read_all(&mut reader).expect_err("refused");
        assert_eq!(code_of(&err), ErrorCode::TextTooLong, "{err:#}");
    }
}

use anyhow::Result;
use std::io::Read;

use crate::text_lang;

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
    reader.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

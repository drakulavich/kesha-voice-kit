use anyhow::Result;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
pub struct TextLangResult {
    pub code: String,
    pub confidence: f64,
}

#[cfg(target_os = "macos")]
pub fn detect_text_language(text: &str) -> Result<TextLangResult> {
    use std::process::Command;

    // Escape text for Swift string literal
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ");

    let swift_code = format!(
        r#"import NaturalLanguage; import Foundation; let r = NLLanguageRecognizer(); r.processString("{}"); var c = ""; var p = 0.0; if let l = r.dominantLanguage {{ c = l.rawValue; p = r.languageHypotheses(withMaximum: 1)[l] ?? 0.0 }}; let d = try! JSONSerialization.data(withJSONObject: ["code": c, "confidence": p], options: [.sortedKeys]); FileHandle.standardOutput.write(d)"#,
        escaped
    );

    let output = Command::new("swift").arg("-e").arg(&swift_code).output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("NLLanguageRecognizer failed: {}", stderr.trim());
    }

    let result: TextLangResult = serde_json::from_slice(&output.stdout)?;
    Ok(result)
}

#[cfg(not(target_os = "macos"))]
pub fn detect_text_language(_text: &str) -> Result<TextLangResult> {
    anyhow::bail!("detect-text-lang is only available on macOS")
}

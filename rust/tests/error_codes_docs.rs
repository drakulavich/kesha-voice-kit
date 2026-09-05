//! docs/errors.md and `kesha-engine describe` name the same codes, in both directions.
mod common;
use std::process::Command;

#[test]
fn errors_doc_and_describe_agree() {
    let doc =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/errors.md")).unwrap();
    let out = Command::new(common::engine_bin())
        .arg("describe")
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let described: Vec<String> = v["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["code"].as_str().unwrap().to_string())
        .collect();
    for code in &described {
        assert!(
            doc.contains(&format!("`{code}`")),
            "{code} is not documented in docs/errors.md"
        );
    }
    for line in doc.lines().filter(|l| l.starts_with("| `E_")) {
        let code = line.trim_start_matches("| `").split('`').next().unwrap();
        assert!(
            described.contains(&code.to_string()),
            "docs/errors.md documents {code}, which describe does not publish"
        );
    }
}

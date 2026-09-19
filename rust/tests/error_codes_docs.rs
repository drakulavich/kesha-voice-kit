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

/// The engine-contract spec's error-taxonomy table must agree with `describe` in both directions (#1229).
#[test]
fn engine_contract_spec_matches_describe() {
    let spec = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../openspec/specs/engine-contract/spec.md"
    ))
    .unwrap();
    let out = Command::new(common::engine_bin())
        .arg("describe")
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let described: Vec<(String, String, bool, String)> = v["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["code"].as_str().unwrap().to_string(),
                e["category"].as_str().unwrap().to_string(),
                e["retryable"].as_bool().unwrap(),
                e["origin"].as_str().unwrap().to_string(),
            )
        })
        .collect();

    let rows: Vec<(String, String, bool, String)> = spec
        .lines()
        .filter(|l| l.starts_with("> | `E_"))
        .map(|line| {
            let cells: Vec<String> = line
                .trim_start_matches('>')
                .split('|')
                .map(|c| c.trim().trim_matches('`').replace("**", ""))
                .filter(|c| !c.is_empty())
                .collect();
            (
                cells[0].clone(),
                cells[1].clone(),
                cells[2].eq_ignore_ascii_case("yes"),
                cells[3].clone(),
            )
        })
        .collect();

    for (code, category, retryable, origin) in &described {
        let row = rows.iter().find(|r| &r.0 == code).unwrap_or_else(|| {
            panic!("engine-contract spec.md has no error-taxonomy row for {code}")
        });
        assert_eq!(
            &row.1, category,
            "{code}: category mismatch between spec.md and describe"
        );
        assert_eq!(
            &row.2, retryable,
            "{code}: retryable mismatch between spec.md and describe"
        );
        assert_eq!(
            &row.3, origin,
            "{code}: origin mismatch between spec.md and describe"
        );
    }
    for (code, ..) in &rows {
        assert!(
            described.iter().any(|d| &d.0 == code),
            "engine-contract spec.md documents {code}, which describe does not publish"
        );
    }
}

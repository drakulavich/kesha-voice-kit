//! Every non-payload line goes through protocol::events; a stray eprintln! bypasses both renderers.
use std::path::Path;

const ALLOWED: &[(&str, &str)] = &[
    ("src/protocol/events.rs", "the renderer itself"),
    (
        "src/debug.rs",
        "v3 debug trace until the shim removal (protocol-v4 Migration)",
    ),
    ("src/record.rs", "one blank separator line"),
];

fn scan(dir: &Path, hits: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let p = entry.unwrap().path();
        if p.is_dir() {
            scan(&p, hits);
            continue;
        }
        if p.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let text = std::fs::read_to_string(&p).unwrap();
        let non_test = text.split("#[cfg(test)]").next().unwrap_or("");
        let rel = p
            .strip_prefix(concat!(env!("CARGO_MANIFEST_DIR"), "/"))
            .unwrap()
            .to_string_lossy()
            .to_string();
        let allowed = ALLOWED.iter().filter(|(f, _)| *f == rel).count();
        let count = non_test.matches("eprintln!").count();
        if count > allowed {
            hits.push(format!("{rel}: {count} eprintln! (allowed {allowed})"));
        }
    }
}

#[test]
fn no_eprintln_outside_the_emitter() {
    let mut hits = Vec::new();
    scan(
        Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src")),
        &mut hits,
    );
    assert!(
        hits.is_empty(),
        "stray eprintln! sites:\n{}",
        hits.join("\n")
    );
}

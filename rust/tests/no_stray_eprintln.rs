//! Every non-payload line goes through protocol::events; a raw stderr write bypasses both renderers.
use std::path::Path;

/// Each entry allows one occurrence in that file, so the count is the ledger of remaining prose.
const ALLOWED: &[(&str, &str)] = &[
    ("src/protocol/events.rs", "the renderer itself"),
    (
        "src/record.rs",
        "the \\r `Listening` painter, V3 + tty only",
    ),
    (
        "src/record.rs",
        "the blank line that closes that painted row",
    ),
    ("src/record.rs", "the is_terminal probe gating both"),
    (
        "src/models/progress.rs",
        "the \\r download bar, V3 + tty only",
    ),
    (
        "src/models/progress.rs",
        "the flush that repaints that bar row",
    ),
    (
        "src/models/download.rs",
        "the is_terminal probe gating the bar",
    ),
];

const PATTERNS: &[&str] = &["eprintln!", "eprint!(", "io::stderr()"];

/// Split at the first `#[cfg(test)] mod`: the attribute on a single item would otherwise un-scan everything after it.
fn non_test_prefix(text: &str) -> &str {
    const ATTR: &str = "#[cfg(test)]";
    let mut from = 0;
    while let Some(idx) = text[from..].find(ATTR) {
        let at = from + idx;
        if text[at + ATTR.len()..].trim_start().starts_with("mod ") {
            return &text[..at];
        }
        from = at + ATTR.len();
    }
    text
}

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
        let non_test = non_test_prefix(&text);
        let rel = p
            .strip_prefix(concat!(env!("CARGO_MANIFEST_DIR"), "/"))
            .unwrap()
            .to_string_lossy()
            .to_string();
        let allowed = ALLOWED.iter().filter(|(f, _)| *f == rel).count();
        let found: Vec<String> = PATTERNS
            .iter()
            .filter_map(|pat| match non_test.matches(pat).count() {
                0 => None,
                n => Some(format!("{n} {pat}")),
            })
            .collect();
        let count: usize = PATTERNS
            .iter()
            .map(|pat| non_test.matches(pat).count())
            .sum();
        if count > allowed {
            hits.push(format!("{rel}: {} (allowed {allowed})", found.join(", ")));
        }
    }
}

#[test]
fn no_raw_stderr_writes_outside_the_emitter() {
    let mut hits = Vec::new();
    scan(
        Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src")),
        &mut hits,
    );
    assert!(
        hits.is_empty(),
        "stderr sites bypassing protocol::events:\n{}",
        hits.join("\n")
    );
}

#[test]
fn the_split_ignores_a_cfg_test_attribute_on_a_single_item() {
    let text =
        "#[cfg(test)]\nfn helper() {}\neprintln!();\n#[cfg(test)]\nmod tests {\n eprintln!();\n}";
    assert_eq!(non_test_prefix(text).matches("eprintln!").count(), 1);
}

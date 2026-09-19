//! `warn` events carry a code the contract calls published, so every call site's code must be in the table.
mod common;
use common::non_test_prefix;
use kesha_engine::protocol::events::WARN_CODES;
use std::collections::BTreeSet;
use std::path::Path;

/// Collects `W_*` identifiers the way the stderr scan collects raw writes: over the source text, not the AST.
fn collect_codes(text: &str, out: &mut BTreeSet<String>) {
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(idx) = text[from..].find("W_") {
        let at = from + idx;
        from = at + 2;
        if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_') {
            continue;
        }
        let end = text[at..]
            .find(|c: char| !c.is_ascii_uppercase() && !c.is_ascii_digit() && c != '_')
            .map(|n| at + n)
            .unwrap_or(text.len());
        out.insert(text[at..end].to_string());
    }
}

fn walk(dir: &Path, skip: &Path, out: &mut BTreeSet<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let p = entry.unwrap().path();
        if p.is_dir() {
            walk(&p, skip, out);
        } else if p.extension().and_then(|e| e.to_str()) == Some("rs") && p != skip {
            let text = std::fs::read_to_string(&p).unwrap();
            // A code named only inside a test module is not a call site, so the split keeps it from publishing itself.
            collect_codes(non_test_prefix(&text), out);
        }
    }
}

#[test]
fn every_call_site_code_is_published_and_every_published_code_is_used() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut used = BTreeSet::new();
    walk(&src, &src.join("protocol").join("events.rs"), &mut used);
    let published: BTreeSet<String> = WARN_CODES.iter().map(|(c, _)| c.to_string()).collect();
    assert_eq!(
        used, published,
        "the warning taxonomy drifted from its call sites"
    );
}

#[test]
fn every_published_code_carries_a_title() {
    for (code, title) in WARN_CODES {
        assert!(code.starts_with("W_"), "{code} is not a warning code");
        assert!(!title.is_empty(), "{code} has no title");
    }
}

#[test]
fn the_collector_takes_whole_identifiers_only() {
    let mut out = BTreeSet::new();
    collect_codes(
        "events::W_VAD_NO_SPEECH, SLOW_W_NOT_A_CODE, W_INSTALL;",
        &mut out,
    );
    assert_eq!(
        out.into_iter().collect::<Vec<_>>(),
        vec!["W_INSTALL", "W_VAD_NO_SPEECH"]
    );
}

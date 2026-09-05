//! `warn` events carry a code the contract calls published, so every call site's code must be in the table.
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

/// A code named only inside a `#[cfg(test)]` module is not a call site, so the split keeps it from publishing itself.
fn non_test_prefix(text: &str) -> &str {
    const MARKERS: [&str; 2] = ["#[cfg(test)]", "#[cfg(all(test,"];
    let mut from = 0;
    loop {
        let Some((at, marker)) = MARKERS
            .iter()
            .filter_map(|m| text[from..].find(m).map(|i| (from + i, *m)))
            .min_by_key(|(i, _)| *i)
        else {
            return text;
        };
        let Some(close) = text[at..].find(']') else {
            return text;
        };
        if text[at + close + 1..].trim_start().starts_with("mod ") {
            return &text[..at];
        }
        from = at + marker.len();
    }
}

fn walk(dir: &Path, skip: &Path, out: &mut BTreeSet<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let p = entry.unwrap().path();
        if p.is_dir() {
            walk(&p, skip, out);
        } else if p.extension().and_then(|e| e.to_str()) == Some("rs") && p != skip {
            let text = std::fs::read_to_string(&p).unwrap();
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
fn the_split_also_stops_at_a_feature_gated_test_module() {
    let text = "events::W_GENERIC;\n#[cfg(all(test, feature = \"x\"))]\nmod gated {\n W_PHANTOM\n}\n#[cfg(test)]\nmod tests {}";
    assert!(!non_test_prefix(text).contains("W_PHANTOM"));
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

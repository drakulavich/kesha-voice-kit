//! Every engine ErrorCode must be documented in docs/errors.md.
use kesha_engine::errors::ErrorCode;

#[test]
fn every_code_is_documented() {
    let doc = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/errors.md"))
        .expect("read docs/errors.md");
    for c in ErrorCode::ALL {
        assert!(
            doc.contains(c.as_str()),
            "{} is not documented in docs/errors.md",
            c.as_str()
        );
    }
}

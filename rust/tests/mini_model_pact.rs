//! Signature parity between the committed Kokoro mini and the real model.
//!
//! The mini (`tests/fixtures/mini-models/kokoro`) exists so structural TTS lanes
//! stop caching 326 MB of weights they never assert on (#741). That trade is only
//! sound while the mini still presents the signature `tts::kokoro` feeds — a pin
//! bump that renamed `tokens` would leave every mini-backed lane green against a
//! model nobody runs.
//!
//! One extractor, two verifiers: this test reads `KESHA_PACT_MODEL` and defaults
//! to the mini, so the per-PR run checks the stand-in and `mini-model-pact.yml`
//! points the same code at the downloaded real model. Both must match the one
//! recorded `signature.json`.

use std::path::PathBuf;

use ort::session::Session;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rust/ has a parent")
        .to_path_buf()
}

fn fixture_dir() -> PathBuf {
    repo_root().join("tests/fixtures/mini-models/kokoro")
}

/// `name: dtype[dim,dim]`, with `-1` for a dynamic dimension. Stable across ort
/// releases in a way `Debug` on its internal types is not.
fn describe(outlets: &[ort::value::Outlet]) -> Vec<String> {
    outlets
        .iter()
        .map(|o| {
            let ty = o.dtype();
            let elem = ty
                .tensor_type()
                .map(|t| format!("{t:?}").to_lowercase())
                .unwrap_or_else(|| "non-tensor".into());
            let dims = ty
                .tensor_shape()
                .map(|s| {
                    s.iter()
                        .map(|d| d.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            format!("{}: {elem}[{dims}]", o.name())
        })
        .collect()
}

#[test]
fn the_model_under_test_matches_the_recorded_kokoro_signature() {
    let model = std::env::var("KESHA_PACT_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| fixture_dir().join("model.onnx"));
    assert!(
        model.exists(),
        "no model at {} — the mini is committed, so this means a bad KESHA_PACT_MODEL",
        model.display()
    );

    let session = Session::builder()
        .expect("ort session builder")
        .commit_from_file(&model)
        .unwrap_or_else(|e| panic!("ort refused {}: {e}", model.display()));

    let recorded: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture_dir().join("signature.json")).unwrap(),
    )
    .expect("signature.json parses");

    let expected_inputs: Vec<String> = serde_json::from_value(recorded["inputs"].clone()).unwrap();
    let expected_outputs: Vec<String> =
        serde_json::from_value(recorded["outputs"].clone()).unwrap();

    assert_eq!(
        describe(session.inputs()),
        expected_inputs,
        "input signature drifted for {}",
        model.display()
    );
    assert_eq!(
        describe(session.outputs()),
        expected_outputs,
        "output signature drifted for {}",
        model.display()
    );
}

#[test]
fn the_mini_declares_itself_a_stand_in() {
    // The marker is how a lane tells mini-staged from real-staged; without it the
    // fixture is indistinguishable from a real cache and could be mistaken for one.
    let marker = fixture_dir().join("MINI-MODEL.json");
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&marker).expect("marker present")).unwrap();
    assert_eq!(parsed["kind"], "mini-model");
    assert_eq!(
        parsed["files"]["am_michael.bin"]["bytes"], 522_240,
        "voice packs are 510 rows x 256 cols x 4 bytes or load_voice rejects them"
    );
}

/// Not just "it loads": the shapes the pact records must be the ones the real
/// inference call feeds, or the pact would pass while `infer` still failed.
#[test]
fn the_mini_answers_the_call_kokoro_actually_makes() {
    let model = fixture_dir().join("model.onnx");
    let mut session = Session::builder()
        .expect("ort session builder")
        .commit_from_file(&model)
        .expect("mini loads");

    let tokens = ndarray::Array2::<i64>::from_shape_vec((1, 12), (0..12).collect()).unwrap();
    let style = ndarray::Array2::<f32>::zeros((1, 256));
    let speed = ndarray::Array1::<f32>::from_vec(vec![1.0]);

    let outputs = session
        .run(ort::inputs![
            "tokens" => ort::value::Value::from_array(tokens).unwrap(),
            "style"  => ort::value::Value::from_array(style).unwrap(),
            "speed"  => ort::value::Value::from_array(speed).unwrap(),
        ])
        .expect("mini runs the call kokoro::infer makes");

    let (shape, audio) = outputs["audio"].try_extract_tensor::<f32>().unwrap();
    assert_eq!(shape.len(), 1, "audio is rank-1, got {shape:?}");
    assert!(!audio.is_empty(), "audio must not be empty");
    assert!(
        audio.iter().all(|s| s.is_finite() && s.abs() <= 1.0),
        "mini must stay inside the range clamp_audio guarantees"
    );
    let rms = (audio.iter().map(|s| s * s).sum::<f32>() / audio.len() as f32).sqrt();
    assert!(rms > 0.01, "mini must be audible, not silence (rms={rms})");
}

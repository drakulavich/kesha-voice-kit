//! A TTS model that is present but will not load is `E_MODEL_LOAD` (exit 1), not `E_INTERNAL`.

#![cfg(feature = "tts")]

mod common;

use std::path::Path;
use std::process::{Command, Output};

const TRUNCATED: [u8; 100] = [0x5a; 100];

fn say(args: &[&str], cache: &Path) -> Output {
    Command::new(common::engine_bin())
        .arg("say")
        .args(args)
        .env("KESHA_CACHE_DIR", cache)
        .output()
        .expect("spawn engine")
}

fn write_truncated(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, TRUNCATED).unwrap();
}

fn assert_model_load(out: &Output, names: &str) {
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert!(out.stdout.is_empty(), "no audio on failure");
    let v = common::sole_error_event(out);
    assert_eq!(v["code"], "E_MODEL_LOAD", "{v}");
    let message = v["message"].as_str().unwrap();
    assert!(message.contains(names), "names the model: {message}");
    assert!(
        message.contains("reinstall it: kesha install --tts"),
        "{message}"
    );
}

#[test]
fn a_truncated_kokoro_model_is_a_model_load_failure_with_a_reinstall_hint() {
    let dir = tempfile::tempdir().unwrap();
    let model = dir.path().join("kokoro/model.onnx");
    let voice = dir.path().join("kokoro/voice.bin");
    write_truncated(&model);
    write_truncated(&voice);
    let out = say(
        &[
            "--model",
            model.to_str().unwrap(),
            "--voice-file",
            voice.to_str().unwrap(),
            "hello",
        ],
        &dir.path().join("cache"),
    );
    assert_model_load(&out, "Kokoro model");
    let message = common::sole_error_event(&out)["message"].to_string();
    assert_eq!(
        message.matches("kokoro load").count(),
        0,
        "no stacked prefixes: {message}"
    );
}

#[test]
fn a_truncated_charsiu_g2p_model_is_a_model_load_failure_with_a_reinstall_hint() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    stage_truncated_charsiu(&cache);
    let model = dir.path().join("kokoro/model.onnx");
    let voice = dir.path().join("kokoro/voice.bin");
    write_truncated(&model);
    write_truncated(&voice);
    let out = say(
        &[
            "--model",
            model.to_str().unwrap(),
            "--voice-file",
            voice.to_str().unwrap(),
            "--lang",
            "es",
            "hola",
        ],
        &cache,
    );
    assert_model_load(&out, "CharsiuG2P model");
}

#[test]
fn a_truncated_vosk_model_is_a_model_load_failure_with_a_reinstall_hint() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    stage_truncated_vosk(&cache);
    let out = say(&["--voice", "ru-vosk-m02", "привет"], &cache);
    assert_model_load(&out, "Vosk model");
}

fn stage_truncated_charsiu(cache: &Path) {
    for file in [
        "encoder_model.onnx",
        "decoder_model.onnx",
        "decoder_with_past_model.onnx",
    ] {
        write_truncated(&cache.join("models/g2p/byt5-tiny").join(file));
    }
}

fn stage_truncated_vosk(cache: &Path) {
    let vosk = cache.join("models/vosk-ru");
    for file in [
        "model.onnx",
        "dictionary",
        "config.json",
        "bert/model.onnx",
        "bert/vocab.txt",
    ] {
        write_truncated(&vosk.join(file));
    }
}

// The SSML walker loads Kokoro before G2P, so this one needs a graph that loads: the committed mini.
#[test]
fn a_truncated_charsiu_g2p_model_under_ssml_is_a_model_load_failure() {
    let mini = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/mini-models/kokoro");
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    stage_truncated_charsiu(&cache);
    let out = say(
        &[
            "--model",
            mini.join("model.onnx").to_str().unwrap(),
            "--voice-file",
            mini.join("am_michael.bin").to_str().unwrap(),
            "--lang",
            "es",
            "--ssml",
            "<speak>hola</speak>",
        ],
        &cache,
    );
    assert_model_load(&out, "CharsiuG2P model");
}

#[test]
fn a_truncated_vosk_model_under_ssml_is_a_model_load_failure() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    stage_truncated_vosk(&cache);
    let out = say(
        &["--voice", "ru-vosk-m02", "--ssml", "<speak>привет</speak>"],
        &cache,
    );
    assert_model_load(&out, "Vosk model");
}

# Mutation evidence — #1093 (Kokoro ANE manifest pinned to a mutable ref)

Guard: `rust/src/models.rs::manifest_tests::every_huggingface_url_pins_an_immutable_revision`
asserts every `huggingface.co` URL in every model manifest resolves a 40-hex commit,
never a mutable ref such as `main`.

Command used to prove it (matches `just mutate`'s default `FEATURES`, since the ANE
manifests are `system_kokoro`-gated and never compile under the default `tts`-only
feature set):

```
just mutate rust/src/models.rs \
  'FluidInference/kokoro-82m-coreml/resolve/c94edcb4b671856795458645cd389c0a9184e8bb/' \
  'FluidInference/kokoro-82m-coreml/resolve/main/' \
  cargo nextest run --manifest-path rust/Cargo.toml \
    --features tts,system_kokoro,system_diarize --no-default-features --features onnx \
    manifest_tests::every_huggingface_url_pins_an_immutable_revision
```

| Mutation | Occurrences | Guard result |
|---|---|---|
| Revert the `FluidInference/kokoro-82m-coreml` pin from the immutable commit `c94edcb4b6…` back to `main` | 5 | **PINNED** — `every_huggingface_url_pins_an_immutable_revision` fails: `pins mutable ref "main" instead of a 40-hex commit` |

Restore-to-green: `just mutate` restores the file in a `finally` regardless of outcome;
`cargo nextest run --features tts,system_kokoro,system_diarize --no-default-features --features onnx manifest_tests::every_huggingface_url_pins_an_immutable_revision`
passes again on the restored file (1 passed, 0 failed).

The same guard also covers the other 6 pinned repos (`istupakov/parakeet-tdt-0.6b-v3-onnx`,
`FluidInference/diar-streaming-sortformer-coreml`, `drakulavich/SpeechBrain-coreml`,
`onnx-community/Kokoro-82M-v1.0-ONNX`, `klebster/g2p_multilingual_byT5_tiny_onnx`,
`drakulavich/vosk-tts-ru-0.9-multi`) under the default `--features tts` build; only the
`FluidInference/kokoro-82m-coreml` mutation above was exercised end-to-end because it is
the repo the ticket's regression came from.

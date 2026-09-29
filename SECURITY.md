# Security Policy

## Supported versions

Only the latest `@drakulavich/kesha-voice-kit` release line receives
security fixes. Since v2.0.0 one version names both the CLI and the engine,
and one `vX.Y.Z` tag releases both, so a fix in either ships as the next
2.x release. To upgrade, run
`bun add -g @drakulavich/kesha-voice-kit@latest`, then `kesha install` to
replace the cached engine with the one the new CLI pins.

| Version       | Supported          |
| ------------- | ------------------ |
| `2.x`         | :white_check_mark: |
| `< 2.0`       | :x:                |

Before v2.0.0 the CLI and the engine were versioned separately, and releases
tagged `vX.Y.Z-cli` were CLI-only markers that reused an earlier engine. None
of those releases receive fixes.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.** Use one of:

1. **GitHub private vulnerability reporting** — open the
   [Security tab](https://github.com/drakulavich/kesha-voice-kit/security)
   and click "Report a vulnerability". Preferred — it goes straight into
   the project's draft-advisory queue.
2. **Email** the maintainer at
   [drakulavich@gmail.com](mailto:drakulavich@gmail.com) with subject
   `[kesha-voice-kit] security:` and a clear reproducer.

When reporting, please include:

- The version (`kesha --version` or `kesha-engine --version`).
- Operating system + architecture.
- A minimal reproducer (input file, command, expected vs actual behavior).
- Any relevant logs from `KESHA_DEBUG=1`.

## What to expect

- Acknowledgement within 72 hours.
- A coordinated disclosure plan (typical: fix released first, then a public
  advisory) or a justification for declining.
- Credit in the release notes if you'd like attribution.

## Surfaces in scope

- The `kesha-engine` Rust binary (model loading, audio I/O, ONNX inference,
  TTS synthesis).
- The Bun/TypeScript CLI (`kesha`, including `transcribe`, `say`, `install`,
  `status`, `detect-lang`, `detect-text-lang`).
- The Raycast extension (`raycast/` subtree).
- The OpenClaw plugin entry (`openclaw-plugin.cjs`,
  `openclaw.plugin.json`).
- Any model-download path or cache-write that can be influenced by attacker
  input (e.g. `KESHA_MODEL_MIRROR`, malicious archives).

## Out of scope

- Vulnerabilities in third-party crates / npm dependencies that we don't
  own — file those upstream. Dependabot tracks them locally and we apply
  fixes via `bun add` / `npm overrides` as they ship.
- Misuse of supplied flags (e.g. running with `--break-system-packages` or
  intentionally pointing `KESHA_ENGINE_BIN` at an attacker-controlled
  binary).
- Speech-to-text or text-to-speech model output quality. Bias and
  hallucination concerns belong to the model authors (NVIDIA Parakeet TDT,
  Hexgrad Kokoro-82M, Alphacephei Vosk-TTS, Apple AVSpeechSynthesizer).

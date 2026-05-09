# darwin-arm64 Speaker Diarization PoC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `kesha --json --timestamps --speakers meeting.m4a` on darwin-arm64, returning per-segment speaker labels via a FluidAudio Swift sidecar; emit a clear `not supported on this platform` error on Linux/Windows. Engine release v1.12.0.

**Architecture:** Mirror the AVSpeech sidecar pattern (#141). New cargo feature `system_diarize` (default-on for darwin-arm64). New Swift binary `kesha-diarize-darwin-arm64` linking the FluidAudio framework, taking a WAV path on argv, emitting JSON spans on stdout. Rust subprocess invocation in `rust/src/transcribe/diarize.rs`; pure-Rust merge step projects ASR segments onto diarization spans by midpoint overlap.

**Tech Stack:** Rust 2024 + Cargo, Swift 5.10+ (FluidAudio framework), Bun/TypeScript CLI. No new ONNX models. No new Python dependencies. No system deps beyond what FluidAudio already requires (macOS 14+, Apple Silicon).

**Spec:** `docs/superpowers/specs/2026-05-09-darwin-diarization-poc-design.md` (commit `6b4d5b3`).

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `swift/kesha-diarize/Package.swift` | NEW | Swift Package manifest pinning the FluidAudio dependency at the version selected by the spike. |
| `swift/kesha-diarize/Sources/kesha-diarize/main.swift` | NEW | Entry point. Argv parsing (`<wav-path>` or `--list-models`), FluidAudio diarization call, JSON emit. ~50 lines. |
| `rust/Cargo.toml` | MODIFY | Add `system_diarize = []` to `[features]`. Default-enable for darwin-arm64 release builds (the build-engine matrix row, NOT the workspace default). |
| `rust/build.rs` | MODIFY | Under `cfg(feature = "system_diarize")` + `cfg(target_os = "macos")`, invoke `swift build` against `swift/kesha-diarize/`, copy output to `$OUT_DIR/kesha-diarize`. Mirrors the AVSpeech bake-in. |
| `rust/src/transcribe.rs` | MODIFY | Extend `TranscriptionSegment` with `pub speaker: Option<u32>` (skip-serialize-if-none). Add `pub const TRANSCRIBE_DIARIZE_FEATURE = "transcribe.diarize";`. Plumb `--speakers` flag through `transcribe_inner` → `transcribe_via_vad`/`transcribe_plain` → optional `diarize::run_and_merge` post-step. |
| `rust/src/transcribe/diarize.rs` | NEW | `pub fn run_and_merge(audio_path: &Path, segments: Vec<TranscriptionSegment>) -> Result<Vec<TranscriptionSegment>>`. Internal: `sidecar_path()` (sibling-of-engine first, `$OUT_DIR/kesha-diarize` fallback), `spawn_sidecar(wav_path)` returning `Vec<DiarizeSpan { start, end, speaker }>`, `merge_into(asr_segs, diarize_spans) -> Vec<TranscriptionSegment>` (pure interval-overlap math, unit-tested). |
| `rust/src/capabilities.rs` | MODIFY | Push `transcribe::TRANSCRIBE_DIARIZE_FEATURE` under `#[cfg(feature = "system_diarize")]`. |
| `rust/src/main.rs` | MODIFY | Add `--speakers` flag to the `Transcribe` subcommand. Auto-imply `--json` (or auto-fail with the gate-violation message if neither `--json`/`--toon`/`--format json` is set). Auto-imply `--timestamps`. On non-darwin or non-`system_diarize` builds: return the platform-not-supported error. |
| `src/engine.ts` | MODIFY | Add `TRANSCRIBE_DIARIZE_FEATURE` const. Capability-gate `--speakers` forwarding in `transcribeEngineWithSegments` (shape mirrors `tts.ru_acronym_expansion` OR `tts.en_acronym_expansion` gate). |
| `src/transcribe.ts` | MODIFY | Add `speakers?: boolean` to `TranscribeOptions`. Forward to engine subprocess. |
| `src/cli/main.ts` | MODIFY | Add `--speakers` flag. Same gate as `--timestamps` (requires `--json` / `--toon` / `--format json`). |
| `src/engine-install.ts` | MODIFY | Add `downloadDiarizeSidecar(binPath, engineVersion)` mirroring the existing `downloadAVSpeechSidecar`. Concurrent fetch with the engine binary. |
| `rust/tests/diarize_e2e.rs` | NEW | Gated by `#[cfg(feature = "system_diarize")]`. Synthesize a 30 s 2-speaker WAV from kesha's own TTS (`am_michael` for spans 1+3, `bm_george` for span 2), run end-to-end via the engine binary's `--stdin-loop`-or-direct path, assert the output JSON has ≥ 2 distinct speaker IDs and ≥ 80% of ASR-detected speech time has a non-`None` speaker. |
| `tests/integration/e2e-engine.test.ts` | MODIFY | Add a `--speakers` round-trip test gated by `os.platform() === 'darwin' && os.arch() === 'arm64'`. |
| `tests/unit/cli.test.ts` | MODIFY | Add 2 unit cases: `--speakers` requires `--json`/`--toon`/`--format json` (exits 2); `--speakers` auto-implies `--timestamps`. |
| `.github/workflows/build-engine.yml` | MODIFY | macos-14 matrix row adds `system_diarize` to its `features` list. Pre-upload smoke runs `kesha-diarize-darwin-arm64 --list-models` and asserts exit 0. Sidecar uploaded as separate release artifact (`kesha-diarize-darwin-arm64`). |
| `README.md`, `SKILL.md`, `docs/tts.md`, `CHANGELOG.md` | MODIFY | Document `--speakers` with examples. |
| `package.json`, `rust/Cargo.toml`, `rust/Cargo.lock` | MODIFY | Lockstep bump to `1.12.0`. |

---

## Pre-flight

- [ ] **Step 0.1: Confirm branch + spec**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git rev-parse --abbrev-ref HEAD
git log -1 --oneline -- docs/superpowers/specs/2026-05-09-darwin-diarization-poc-design.md
```
Expected: branch `feat/199-darwin-diarization`; spec commit `6b4d5b3`.

- [ ] **Step 0.2: Confirm baseline tests + clippy + fmt are green**

```bash
cd rust && cargo test --no-default-features --features onnx,tts --lib 2>&1 | tail -3
cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -3
cargo fmt --check && echo fmt-clean
cd .. && bun test 2>&1 | tail -3
bunx tsc --noEmit && echo tsc-clean
```
Expected: 157+ rust lib tests pass, clippy clean, fmt clean, bun 147 pass + 4 skip, tsc clean. If any fail, stop — don't add new code on a broken base.

- [ ] **Step 0.3: Stage evidence directory**

```bash
mkdir -p /tmp/kesha-199-evidence
```

---

## Task 1: FluidAudio spike (BLOCKING gate before any kesha code is committed)

**This task is measurement-only.** Per CLAUDE.md "VERIFY THIRD-PARTY MODEL FORMATS WITH A SPIKE", validate the FluidAudio Swift API end-to-end before committing to the design. Spike artifacts go in `/tmp/kesha-diarize-spike/`; nothing here ships in the repo.

**Files:** none in the repo.
**Output:** `/tmp/kesha-199-evidence/T1-spike.notes` recording the answers to the 5 questions in spec Section 5.

- [ ] **Step 1.1: Spike workspace**

```bash
SPIKE=/tmp/kesha-diarize-spike && rm -rf "$SPIKE" && mkdir -p "$SPIKE"
cd "$SPIKE"
```

- [ ] **Step 1.2: Q1 — Swift API surface check**

Create a minimal Swift Package that imports FluidAudio, lists the diarization symbols, and compiles. Confirm `import FluidAudio` exposes a callable `diarize(...)` with a signature compatible with `(URL) -> [(start: Double, end: Double, speakerId: Int)]` (or similar).

```bash
cat > "$SPIKE/Package.swift" <<'EOF'
// swift-tools-version: 5.10
import PackageDescription
let package = Package(
    name: "spike",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.1.0"),
    ],
    targets: [
        .executableTarget(name: "spike", dependencies: ["FluidAudio"]),
    ]
)
EOF
mkdir -p "$SPIKE/Sources/spike"
cat > "$SPIKE/Sources/spike/main.swift" <<'EOF'
import FluidAudio
print("FluidAudio version: \(FluidAudio.version)")
// Probe diarization symbol existence at compile time.
let _: Any = FluidAudio.Diarizer.self
EOF
swift build 2>&1 | tail -20
```

Expected (Q1 PASS): build succeeds; running `swift run` prints a version. If `FluidAudio.Diarizer` isn't a real symbol, the compile fails — that's Q1 FAIL.

If Q1 FAIL: STOP. Re-open spec Q4. The pivot is to ONNX cross-platform diarization (Approach 1 from brainstorm). Plan revisions: replace Tasks 4–5 (Swift sidecar) with an ONNX speaker-embedding path, replace Task 13's macOS-only build with cross-platform, drop the platform-not-supported gate. The rest of the plan (capability flag, `--speakers` CLI, merge logic, integration test) survives nearly intact.

- [ ] **Step 1.3: Q2 — Model bundling**

Disable network and run the spike against a local 5 s WAV. If the call succeeds offline, models are framework-bundled. If it fails with a network error, models are lazy-downloaded from a network endpoint.

```bash
echo "Hello world this is speaker one." | rust/target/release/kesha-engine say --voice en-am_michael --out "$SPIKE/probe-5s.wav"
# Disable network using firewall rules, or run after network detach:
swift run spike "$SPIKE/probe-5s.wav" 2>&1 | tail -10
```

Expected (record in notes):
- "Models bundled — works offline." OR
- "Models lazy-downloaded to `~/Library/Caches/...` on first call; offline call fails with `<error>`."

- [ ] **Step 1.4: Q3 — Output shape sanity (2-speaker)**

Synthesize a deterministic 2-speaker fixture using kesha's TTS:

```bash
( echo "Hello everyone, this is the first speaker beginning the call."; \
  echo "<break time=\"500ms\"/>"; \
  echo "Hi, this is the second speaker responding now."; \
  echo "<break time=\"500ms\"/>"; \
  echo "Yes thanks for joining, the first speaker again." ) > "$SPIKE/dialogue.txt"

# Spans 1+3 use am_michael; span 2 uses bm_george. Concatenate via two say calls and ffmpeg.
echo "Hello everyone, this is the first speaker beginning the call." \
  | rust/target/release/kesha-engine say --voice en-am_michael --out "$SPIKE/p1a.wav"
echo "Hi, this is the second speaker responding now." \
  | rust/target/release/kesha-engine say --voice en-bm_george --out "$SPIKE/p2.wav"
echo "Yes thanks for joining, the first speaker again." \
  | rust/target/release/kesha-engine say --voice en-am_michael --out "$SPIKE/p1b.wav"
ffmpeg -y -i "concat:$SPIKE/p1a.wav|$SPIKE/p2.wav|$SPIKE/p1b.wav" -c copy "$SPIKE/dialogue.wav" 2>&1 | tail -2
```

Run the spike binary:
```bash
swift run spike "$SPIKE/dialogue.wav" | jq '.spans | group_by(.speaker) | map({speaker: .[0].speaker, count: length})'
```

Expected (Q3 PASS): JSON has spans grouped into exactly 2 distinct speaker IDs; counts roughly match input (2 spans for speaker 0, 1 span for speaker 1, or similar).

Failure modes:
- 1 cluster: under-clustering (model treats the call as one speaker) — note in spike findings, may need a clustering threshold knob in v2.
- 4+ clusters: over-segmentation — same note.
- 0 spans / empty: model not loaded — diagnostic-only failure, retry after Q2 cache populated.

- [ ] **Step 1.5: Q4 — Latency on a 1 h file**

Use any pre-recorded 1 h podcast / meeting / public-domain audiobook. Time the wall-clock from sidecar start to JSON emit:

```bash
# Pick or record a 1h source.
LONG="$SPIKE/long-1h.m4a"  # provide via curl or local fixture
ffmpeg -y -i "$LONG" -ar 16000 -ac 1 -c:a pcm_f32le "$SPIKE/long-1h.wav" 2>&1 | tail -1
time swift run spike "$SPIKE/long-1h.wav" > "$SPIKE/long-1h-spans.json"
jq '.spans | length' "$SPIKE/long-1h-spans.json"
```

Expected (record in notes): wall-clock seconds. Decision rules:
- < 5 s: no progress UI needed in v1.
- 5–60 s: emit a single `eprintln!("diarizing 1h audio (this may take a minute)…");` line up front.
- > 60 s: capture in spike notes; user-visible progress is a v2 follow-up.

- [ ] **Step 1.6: Q5 — Russian language quality**

Synthesize a Russian 2-speaker dialogue (`ru-vosk-m02` for speaker 0, `ru-vosk-m01` for speaker 1) and run the spike. Inspect cluster count + boundary accuracy.

```bash
echo "Привет, это первый собеседник, начинаю разговор." \
  | rust/target/release/kesha-engine say --voice ru-vosk-m02 --out "$SPIKE/ru-p1a.wav"
echo "Здравствуйте, я второй собеседник, отвечаю на вопрос." \
  | rust/target/release/kesha-engine say --voice ru-vosk-m01 --out "$SPIKE/ru-p2.wav"
echo "Спасибо за встречу, я снова первый." \
  | rust/target/release/kesha-engine say --voice ru-vosk-m02 --out "$SPIKE/ru-p1b.wav"
ffmpeg -y -i "concat:$SPIKE/ru-p1a.wav|$SPIKE/ru-p2.wav|$SPIKE/ru-p1b.wav" -c copy "$SPIKE/ru-dialogue.wav" 2>&1 | tail -1
swift run spike "$SPIKE/ru-dialogue.wav" | jq '.spans | group_by(.speaker) | length'
```

Expected (record in notes): "2 distinct clusters on Russian dialogue — passes" OR "1 cluster (Russian under-clustered) — add stderr language-mismatch warning per spec Section 5 decision tree".

- [ ] **Step 1.7: Record findings + clean up**

```bash
cat > /tmp/kesha-199-evidence/T1-spike.notes <<EOF
Spike date: $(date -u +%Y-%m-%dT%H:%M:%SZ)

Q1 (Swift API surface):     <PASS|FAIL — symbol name, signature>
Q2 (Model bundling):        <bundled|lazy-downloaded — cache path if lazy>
Q3 (2-speaker output):      <2 clusters|N clusters — counts per cluster>
Q4 (1h latency):            <wall-clock seconds>
Q5 (Russian quality):       <passes|under-clustered — observed cluster count>

Decision: <proceed to Task 2|pivot to ONNX|wait for FluidAudio release>
EOF
cat /tmp/kesha-199-evidence/T1-spike.notes
rm -rf "$SPIKE"
```

- [ ] **Step 1.8: Update spec Section 5 with the findings**

Edit `docs/superpowers/specs/2026-05-09-darwin-diarization-poc-design.md` to replace each `TODO` in the "Spike findings" table with the recorded answer. Commit the spec amendment:

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git add docs/superpowers/specs/2026-05-09-darwin-diarization-poc-design.md
git commit -m "$(cat <<'EOF'
docs(#199): record FluidAudio spike findings (T1)

Spike steps Q1-Q5 measured in /tmp/kesha-199-evidence/T1-spike.notes.
Spec Section 5 TODOs replaced with measured outcomes; decision branch
selected per the spec's exit-points table.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T1-spike.sha
```

**Gate**: if Q1 failed, STOP and re-plan against ONNX backend before T2. Otherwise proceed.

---

## Task 2: Add `system_diarize` cargo feature + capability constant

Mechanical: declare the feature flag, add a no-op consumer in capabilities.rs that compiles only on macOS with the feature on. Pure plumbing — no Swift, no sidecar, no behavior. Land first so subsequent tasks have the feature gate to compile against.

**Files:**
- Modify: `rust/Cargo.toml`
- Modify: `rust/src/transcribe.rs`
- Modify: `rust/src/capabilities.rs`

- [ ] **Step 2.1: Declare the feature**

In `rust/Cargo.toml`, find the `[features]` block. Add:

```toml
system_diarize = []
```

Do NOT add to the workspace `default` features (gating happens at the build-engine matrix-row level — Linux/Windows do not get this feature).

- [ ] **Step 2.2: Add the capability constant**

In `rust/src/transcribe.rs`, near the existing `TRANSCRIBE_SEGMENTS_FEATURE` const, add:

```rust
/// Capability flag surfaced via `--capabilities-json` when the engine ships
/// with FluidAudio diarization. Only true on darwin-arm64 release builds
/// that include the `system_diarize` feature. Closes #199 angle D.
pub const TRANSCRIBE_DIARIZE_FEATURE: &str = "transcribe.diarize";
```

- [ ] **Step 2.3: Capabilities consumer**

In `rust/src/capabilities.rs`, after the existing `transcribe::TRANSCRIBE_SEGMENTS_FEATURE` push, add:

```rust
#[cfg(feature = "system_diarize")]
features.push(transcribe::TRANSCRIBE_DIARIZE_FEATURE);
```

- [ ] **Step 2.4: Compile gate sanity**

```bash
cd rust
cargo check --no-default-features --features onnx,tts 2>&1 | tail -3   # no system_diarize
cargo check --no-default-features --features onnx,tts,system_diarize 2>&1 | tail -3   # with feature
```
Expected: both compile.

- [ ] **Step 2.5: Commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git add rust/Cargo.toml rust/src/transcribe.rs rust/src/capabilities.rs
git commit -m "$(cat <<'EOF'
feat(#199): add system_diarize cargo feature + TRANSCRIBE_DIARIZE_FEATURE const

Mechanical plumbing for the darwin-arm64 diarization PoC. Feature is
NOT in the workspace default; build-engine.yml turns it on for the
macos-14 matrix row in a later task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T2-feature.sha
```

---

## Task 3: Extend `TranscriptionSegment` with `speaker: Option<u32>`

Pure data-shape change. Add the field, set to `None` everywhere it's currently constructed, verify serialized JSON omits it when `None` (`#[serde(skip_serializing_if = "Option::is_none")]`).

**Files:**
- Modify: `rust/src/transcribe.rs`

- [ ] **Step 3.1: Write the failing test first**

Append to the inline `#[cfg(test)] mod tests` in `rust/src/transcribe.rs`:

```rust
#[test]
fn transcription_segment_speaker_field_omits_when_none() {
    let s = TranscriptionSegment {
        start: 0.0,
        end: 1.0,
        text: "hi".into(),
        speaker: None,
    };
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("\"speaker\""), "speaker:None should be omitted, got {json}");
}

#[test]
fn transcription_segment_speaker_field_serializes_when_some() {
    let s = TranscriptionSegment {
        start: 0.0,
        end: 1.0,
        text: "hi".into(),
        speaker: Some(2),
    };
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("\"speaker\":2"), "got {json}");
}
```

- [ ] **Step 3.2: Run — both should fail to compile (no `speaker` field yet)**

```bash
cd rust && cargo test --no-default-features --features onnx,tts --lib transcription_segment_speaker 2>&1 | tail -5
```
Expected: compile error "no field `speaker` on type `TranscriptionSegment`".

- [ ] **Step 3.3: Add the field**

In `rust/src/transcribe.rs`, replace the existing `TranscriptionSegment`:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptionSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<u32>,
}
```

- [ ] **Step 3.4: Update construction sites**

Find every `TranscriptionSegment { ... }` literal (4 sites: `whole_file_segment`, `single_segment`, `transcribe_via_vad`'s VAD-fallback path, the `build_vad_output_segments` helper). Add `speaker: None,` to each.

```bash
grep -n 'TranscriptionSegment {' rust/src/transcribe.rs
```
Update each to include `speaker: None,`.

- [ ] **Step 3.5: Run tests — both pass + existing tests stay green**

```bash
cargo test --no-default-features --features onnx,tts --lib 2>&1 | tail -3
```
Expected: 159 passed (157 existing + 2 new).

- [ ] **Step 3.6: Run clippy + fmt**

```bash
cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -3
cargo fmt --check && echo fmt-clean
```

- [ ] **Step 3.7: Commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git add rust/src/transcribe.rs
git commit -m "$(cat <<'EOF'
feat(#199): TranscriptionSegment.speaker: Option<u32>

Optional cluster-id field. Serialized only when Some; JSON output
remains byte-identical for callers that don't request --speakers.
Two unit tests lock the skip-when-none + serialize-when-some shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T3-segment-field.sha
```

---

## Task 4: Swift sidecar (`swift/kesha-diarize/`)

Tiny Swift program. Argv layout: `kesha-diarize-darwin-arm64 <wav-path>` synthesizes; `kesha-diarize-darwin-arm64 --list-models` prints model identifiers and exits 0. JSON on stdout, errors on stderr.

**Files:**
- Create: `swift/kesha-diarize/Package.swift`
- Create: `swift/kesha-diarize/Sources/kesha-diarize/main.swift`

- [ ] **Step 4.1: Package manifest**

Write `swift/kesha-diarize/Package.swift`:

```swift
// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "kesha-diarize",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git",
                 from: "0.1.0"),  // <-- replace with the version measured in spike Q1
    ],
    targets: [
        .executableTarget(
            name: "kesha-diarize",
            dependencies: ["FluidAudio"]
        )
    ]
)
```

The `from: "0.1.0"` is a placeholder — replace with the FluidAudio version recorded in spike Q1 findings.

- [ ] **Step 4.2: Sidecar entry point**

Write `swift/kesha-diarize/Sources/kesha-diarize/main.swift`:

```swift
import Foundation
import FluidAudio

struct Span: Encodable {
    let start: Double
    let end: Double
    let speaker: UInt32
}

struct Output: Encodable {
    let spans: [Span]
}

func usage() -> Never {
    FileHandle.standardError.write(Data("usage: kesha-diarize <wav-path> | --list-models\n".utf8))
    exit(2)
}

let args = CommandLine.arguments
if args.count != 2 { usage() }

let arg = args[1]

if arg == "--list-models" {
    // FluidAudio.Diarizer.modelIdentifier (or equivalent) per spike Q1 finding.
    // Adjust to match the actual API surface measured in T1.
    let id = FluidAudio.Diarizer.modelIdentifier
    print("\(id)")
    exit(0)
}

let url = URL(fileURLWithPath: arg)
guard FileManager.default.fileExists(atPath: url.path) else {
    FileHandle.standardError.write(Data("error: audio file not found: \(arg)\n".utf8))
    exit(1)
}

do {
    // The diarize call signature comes from the spike Q1 findings. Adjust the
    // type-annotated bindings below if the upstream API differs.
    let diarizer = try FluidAudio.Diarizer()
    let result = try diarizer.diarize(audioFileURL: url)

    let spans = result.map { Span(start: $0.start, end: $0.end, speaker: UInt32($0.speakerId)) }
    let json = try JSONEncoder().encode(Output(spans: spans))
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("error: diarize failed: \(error)\n".utf8))
    exit(1)
}
```

> **Note:** the `FluidAudio.Diarizer.modelIdentifier` and `try diarizer.diarize(audioFileURL:)` symbols are placeholder shapes informed by the spec. The spike Q1 step measures the actual symbols; revise this file to match the recorded findings before building.

- [ ] **Step 4.3: Sanity build (cargo-independent)**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/swift/kesha-diarize
swift build 2>&1 | tail -10
swift run kesha-diarize --list-models
```
Expected: build succeeds; `--list-models` prints a non-empty identifier.

- [ ] **Step 4.4: Test on the spike fixture (smoke)**

```bash
swift run kesha-diarize /tmp/kesha-199-evidence/T1-dialogue.wav 2>&1 | head -20
```
Expected: JSON with `spans:` array containing ≥ 2 distinct `speaker` integers.

- [ ] **Step 4.5: Commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git add swift/kesha-diarize/
git commit -m "$(cat <<'EOF'
feat(#199): swift/kesha-diarize sidecar source

~50-line Swift program. Argv: <wav-path> | --list-models. JSON spans on
stdout, errors on stderr. Mirrors swift/say-avspeech.swift wiring (#141).
Swift symbols match FluidAudio API as measured in spike T1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T4-sidecar.sha
```

---

## Task 5: `rust/build.rs` bakes the sidecar

Compile the Swift package during `cargo build` when `system_diarize` is on AND target is darwin. Output goes to `$OUT_DIR/kesha-diarize` so dev (`cargo run`) has it adjacent. Mirrors AVSpeech bake-in.

**Files:**
- Modify: `rust/build.rs`

- [ ] **Step 5.1: Read the existing AVSpeech wiring for reference**

```bash
grep -n 'say-avspeech\|swift build\|system_tts' rust/build.rs | head -20
```
The AVSpeech case is precedent — copy the shape, swap names.

- [ ] **Step 5.2: Add the diarize bake-in**

Append to `rust/build.rs`, inside the macOS-only block, after the AVSpeech section:

```rust
#[cfg(all(feature = "system_diarize", target_os = "macos", target_arch = "aarch64"))]
{
    use std::process::Command;

    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let swift_pkg = std::path::Path::new(manifest_dir)
        .parent()
        .unwrap()
        .join("swift/kesha-diarize");
    let out_dir = std::env::var("OUT_DIR").unwrap();

    println!("cargo:rerun-if-changed={}", swift_pkg.display());

    let status = Command::new("swift")
        .arg("build")
        .arg("--configuration")
        .arg("release")
        .arg("--package-path")
        .arg(&swift_pkg)
        .status()
        .expect("failed to invoke swift build for kesha-diarize");
    assert!(status.success(), "swift build kesha-diarize failed");

    let built = swift_pkg
        .join(".build/release/kesha-diarize");
    let target = std::path::Path::new(&out_dir).join("kesha-diarize");
    std::fs::copy(&built, &target)
        .expect("copy kesha-diarize sidecar to OUT_DIR");
    println!("cargo:rustc-env=KESHA_DIARIZE_SIDECAR={}", target.display());
}
```

- [ ] **Step 5.3: Sanity build with the feature**

```bash
cd rust
cargo build --no-default-features --features onnx,tts,system_diarize 2>&1 | tail -10
```
Expected: builds successfully; `target/debug/build/kesha-engine-*/out/kesha-diarize` exists.

```bash
find target -name 'kesha-diarize' -type f 2>/dev/null
```

- [ ] **Step 5.4: Commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git add rust/build.rs
git commit -m "$(cat <<'EOF'
feat(#199): rust/build.rs bakes kesha-diarize sidecar under system_diarize

Mirrors the AVSpeech bake-in. Compiles swift/kesha-diarize Package.swift
when feature is on AND target is darwin-arm64; copies the release build
to $OUT_DIR/kesha-diarize so cargo run / cargo test find it via the
KESHA_DIARIZE_SIDECAR env var.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T5-build-rs.sha
```

---

## Task 6: `rust/src/transcribe/diarize.rs` — sidecar invocation + JSON parse

Subprocess wrapper. Exposes `pub fn run(audio_path: &Path) -> Result<Vec<DiarizeSpan>>`. Path resolution: sibling-of-engine first (release layout `~/.cache/kesha/bin/kesha-diarize-darwin-arm64`), then `$OUT_DIR/kesha-diarize` baked by Task 5. JSON parse via serde.

**Files:**
- Modify: `rust/src/transcribe.rs` (add `mod diarize;`)
- Create: `rust/src/transcribe/diarize.rs`

- [ ] **Step 6.1: Restructure transcribe.rs into a module**

If `transcribe.rs` is a single file (current state), split it: turn `transcribe.rs` into `transcribe/mod.rs` so the `diarize` submodule fits under it.

```bash
cd rust/src
mkdir transcribe
git mv transcribe.rs transcribe/mod.rs
```

Update the parent `lib.rs` / `main.rs` declarations if they differ from `pub mod transcribe;` (likely already fine).

- [ ] **Step 6.2: Module declaration**

In `rust/src/transcribe/mod.rs`, near the top after `use` lines, add:

```rust
#[cfg(all(feature = "system_diarize", target_os = "macos"))]
mod diarize;
```

- [ ] **Step 6.3: Create `rust/src/transcribe/diarize.rs`**

```rust
//! Speaker diarization on darwin-arm64 via the `kesha-diarize-darwin-arm64`
//! Swift sidecar (FluidAudio framework). Mirrors the AVSpeech sidecar
//! pattern. Closes #199 angle D.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::TranscriptionSegment;

/// One speaker span emitted by the sidecar. Cluster IDs are stable within
/// one invocation but not across calls.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DiarizeSpan {
    pub start: f32,
    pub end: f32,
    pub speaker: u32,
}

#[derive(Debug, Deserialize)]
struct SidecarOutput {
    spans: Vec<DiarizeSpan>,
}

/// Resolve the sidecar path. Sibling-of-engine first (release layout),
/// `$OUT_DIR/kesha-diarize` fallback for `cargo run` / `cargo test`.
fn sidecar_path() -> Result<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let sib = parent.join("kesha-diarize-darwin-arm64");
            if sib.exists() {
                return Ok(sib);
            }
            let sib_short = parent.join("kesha-diarize");
            if sib_short.exists() {
                return Ok(sib_short);
            }
        }
    }
    if let Some(dev) = option_env!("KESHA_DIARIZE_SIDECAR") {
        let p = PathBuf::from(dev);
        if p.exists() {
            return Ok(p);
        }
    }
    bail!(
        "kesha-diarize sidecar not found next to engine binary; run `kesha install` to fetch it"
    )
}

/// Run the sidecar against `audio_path` (must be a 16 kHz mono f32 IEEE_FLOAT WAV).
/// Returns the parsed span list, or an error mapping the sidecar's stderr.
pub fn run(audio_path: &Path) -> Result<Vec<DiarizeSpan>> {
    let sidecar = sidecar_path()?;
    let output = Command::new(&sidecar)
        .arg(audio_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("failed to spawn {}", sidecar.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("kesha-diarize exited {}: {stderr}", output.status));
    }
    let parsed: SidecarOutput = serde_json::from_slice(&output.stdout)
        .with_context(|| format!("invalid JSON from kesha-diarize: {}", String::from_utf8_lossy(&output.stdout)))?;
    Ok(parsed.spans)
}

/// Project ASR segments onto the diarization timeline by midpoint overlap.
/// For each ASR segment, find the diarize span whose `[start, end)` covers
/// the ASR segment's midpoint; assign that span's speaker to the segment.
/// `O(N log M)` via binary search, or `O(N + M)` two-pointer if both lists
/// are sorted (they should be).
pub fn merge_into(
    asr_segs: Vec<TranscriptionSegment>,
    diarize_spans: &[DiarizeSpan],
) -> Vec<TranscriptionSegment> {
    asr_segs
        .into_iter()
        .map(|mut seg| {
            let midpoint = (seg.start + seg.end) / 2.0;
            seg.speaker = diarize_spans
                .iter()
                .find(|s| s.start <= midpoint && midpoint < s.end)
                .map(|s| s.speaker);
            seg
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f32, end: f32, text: &str) -> TranscriptionSegment {
        TranscriptionSegment {
            start,
            end,
            text: text.into(),
            speaker: None,
        }
    }
    fn span(start: f32, end: f32, speaker: u32) -> DiarizeSpan {
        DiarizeSpan { start, end, speaker }
    }

    #[test]
    fn one_to_one_overlap_assigns_speaker() {
        let segs = vec![seg(1.0, 3.0, "hi")];
        let spans = vec![span(0.0, 5.0, 7)];
        let out = merge_into(segs, &spans);
        assert_eq!(out[0].speaker, Some(7));
    }

    #[test]
    fn no_overlap_yields_none() {
        let segs = vec![seg(10.0, 11.0, "hi")];
        let spans = vec![span(0.0, 5.0, 0)];
        let out = merge_into(segs, &spans);
        assert_eq!(out[0].speaker, None);
    }

    #[test]
    fn span_split_assigns_to_majority_overlap_via_midpoint() {
        // ASR seg 1.0-3.0; midpoint 2.0. Spans: 0..1.5 (speaker 0), 1.5..5 (speaker 1).
        // Midpoint 2.0 ∈ [1.5, 5) → speaker 1.
        let segs = vec![seg(1.0, 3.0, "hi")];
        let spans = vec![span(0.0, 1.5, 0), span(1.5, 5.0, 1)];
        let out = merge_into(segs, &spans);
        assert_eq!(out[0].speaker, Some(1));
    }

    #[test]
    fn empty_diarize_spans_yield_all_none() {
        let segs = vec![seg(0.0, 1.0, "a"), seg(1.0, 2.0, "b")];
        let out = merge_into(segs, &[]);
        assert!(out.iter().all(|s| s.speaker.is_none()));
    }

    #[test]
    fn empty_asr_segs_returns_empty() {
        let out = merge_into(vec![], &[span(0.0, 5.0, 0)]);
        assert!(out.is_empty());
    }

    #[test]
    fn four_speaker_meeting_assigns_distinct_ids() {
        let segs = vec![
            seg(0.5, 1.5, "a"),
            seg(2.0, 3.0, "b"),
            seg(4.0, 5.0, "c"),
            seg(6.0, 7.0, "d"),
        ];
        let spans = vec![
            span(0.0, 1.7, 0),
            span(1.7, 3.5, 1),
            span(3.5, 5.5, 2),
            span(5.5, 8.0, 3),
        ];
        let out = merge_into(segs, &spans);
        assert_eq!(
            out.iter().map(|s| s.speaker).collect::<Vec<_>>(),
            vec![Some(0), Some(1), Some(2), Some(3)]
        );
    }
}
```

- [ ] **Step 6.4: Run tests**

```bash
cd rust
cargo test --no-default-features --features onnx,tts,system_diarize --lib transcribe::diarize 2>&1 | tail -10
```
Expected: 6 tests pass.

- [ ] **Step 6.5: Commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git add rust/src/transcribe/
git commit -m "$(cat <<'EOF'
feat(#199): transcribe::diarize module — sidecar wrapper + merge logic

Public surface: pub fn run(audio_path) -> Result<Vec<DiarizeSpan>> spawns
the kesha-diarize-darwin-arm64 sidecar and parses its JSON output. pub fn
merge_into(asr_segs, diarize_spans) projects ASR segments onto the
diarization timeline by midpoint overlap; pure interval arithmetic, fully
unit-tested with 6 cases covering 1:1 overlap, no overlap, span-split,
empty inputs, and 4-speaker meetings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T6-diarize-module.sha
```

---

## Task 7: Wire `--speakers` into `transcribe_inner` post-step

After `transcribe_via_vad` / `transcribe_plain` returns, if `speakers_required` is true and we're on a `system_diarize` build, run `diarize::run` against the audio path and merge.

**Files:**
- Modify: `rust/src/transcribe/mod.rs`

- [ ] **Step 7.1: Add `speakers_required` to `transcribe_inner`**

Existing signature:
```rust
fn transcribe_inner(
    audio_path: &str,
    mode: VadMode,
    timestamps_required: bool,
) -> Result<TranscriptionOutput> { ... }
```

New signature:
```rust
fn transcribe_inner(
    audio_path: &str,
    mode: VadMode,
    timestamps_required: bool,
    speakers_required: bool,
) -> Result<TranscriptionOutput> { ... }
```

`speakers_required` implies `timestamps_required` upstream — the CLI flag handler passes both. The function does not re-impose the implication.

- [ ] **Step 7.2: Add the post-step**

Inside `transcribe_inner`, after the existing decision branch returns the `TranscriptionOutput`, add:

```rust
let mut output = output;
#[cfg(all(feature = "system_diarize", target_os = "macos"))]
{
    if speakers_required {
        let spans = diarize::run(std::path::Path::new(audio_path))
            .with_context(|| "speaker diarization failed")?;
        output.segments = diarize::merge_into(output.segments, &spans);
    }
}
#[cfg(not(all(feature = "system_diarize", target_os = "macos")))]
{
    if speakers_required {
        anyhow::bail!(
            "speaker diarization is currently darwin-arm64 only.\n\
             Tracked at https://github.com/drakulavich/kesha-voice-kit/issues/199.",
        );
    }
}
Ok(output)
```

(Adjust binding names to match your actual control-flow shape — the key idea is "after `output` is computed, optionally run diarize+merge".)

- [ ] **Step 7.3: Update callers**

`pub fn transcribe(audio_path, mode) -> Result<String>` and `pub fn transcribe_output(audio_path, mode) -> Result<TranscriptionOutput>` are the existing public entry points. They pass `false` for both flags (text-only / pure-text-with-segments).

Add a third public entry point:
```rust
pub fn transcribe_output_with_speakers(
    audio_path: &str,
    mode: VadMode,
) -> Result<TranscriptionOutput> {
    transcribe_inner(audio_path, mode, true, true)
}
```

- [ ] **Step 7.4: Run tests**

```bash
cd rust
cargo test --no-default-features --features onnx,tts --lib 2>&1 | tail -3       # without feature
cargo test --no-default-features --features onnx,tts,system_diarize --lib 2>&1 | tail -3   # with feature
```
Expected: 159+ tests pass in both modes (the speaker-related tests are gated; existing tests untouched).

- [ ] **Step 7.5: Commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git add rust/src/transcribe/mod.rs
git commit -m "$(cat <<'EOF'
feat(#199): wire --speakers post-step into transcribe_inner

After ASR completes, if speakers_required is set: on
darwin-arm64+system_diarize, invoke diarize::run + merge; otherwise
return the platform-not-supported error pointing at #199. Adds
pub fn transcribe_output_with_speakers as the public entry point.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T7-wire.sha
```

---

## Task 8: Engine CLI `--speakers` flag

Wire clap. Auto-imply `--timestamps`. Gate on `--json`/`--toon`/`--format json` (matches the existing `--timestamps` gate).

**Files:**
- Modify: `rust/src/main.rs`

- [ ] **Step 8.1: Add the flag**

In the `Transcribe` subcommand args struct:

```rust
/// Include speaker labels in transcript segments. Requires --json / --toon /
/// --format json. Implies --timestamps. Currently darwin-arm64 only.
#[arg(long)]
speakers: bool,
```

- [ ] **Step 8.2: Gate + dispatch**

In the `Transcribe` match arm, BEFORE the existing transcribe call:

```rust
if speakers {
    if !json && format.as_deref() != Some("json") && !toon {
        anyhow::bail!("--speakers requires --json / --toon / --format json");
    }
    // Implies --timestamps; downstream sees both as true.
    let mode = VadMode::from_flags(vad, no_vad);
    let out = transcribe::transcribe_output_with_speakers(&audio_path, mode)?;
    if json {
        println!("{}", serde_json::to_string(&out)?);
    } else if toon {
        println!("{}", toon::encode(&out)?);  // or your existing toon helper
    } else {
        println!("{}", serde_json::to_string(&out)?);
    }
    return Ok(());
}
```

(Use whatever `--json`/`--toon` selector exists in the current `main.rs`; the structure here is illustrative.)

- [ ] **Step 8.3: Smoke**

```bash
cd rust
cargo build --release --no-default-features --features onnx,tts,system_diarize 2>&1 | tail -3
./target/release/kesha-engine transcribe --speakers /path/to/short.wav 2>&1 | tail -3   # → exit 2 with the gate message
./target/release/kesha-engine transcribe --json --speakers /path/to/short.wav | jq '.segments[0]'
```
Expected: gate message on missing `--json`; on success, JSON segment includes `speaker` field.

- [ ] **Step 8.4: Commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git add rust/src/main.rs
git commit -m "$(cat <<'EOF'
feat(#199): kesha-engine transcribe --speakers flag

Wires the engine CLI flag. Gate matches --timestamps shape (requires
machine-readable output). Implies --timestamps. Calls transcribe_output_with_speakers
on darwin-arm64 system_diarize builds; cross-platform error otherwise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T8-engine-cli.sha
```

---

## Task 9: TS-side capability gate + flag forwarding

Mirror the existing `transcribe.segments` plumbing. Add `TRANSCRIBE_DIARIZE_FEATURE` const, extend `TranscribeOptions`, gate forwarding on capability presence.

**Files:**
- Modify: `src/engine.ts`
- Modify: `src/transcribe.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 9.1: Engine.ts const + capability**

Append to `src/engine.ts` near `TRANSCRIBE_SEGMENTS_FEATURE`:

```ts
export const TRANSCRIBE_DIARIZE_FEATURE = "transcribe.diarize";
```

In `transcribeEngineWithSegments`, extend the option object:

```ts
export interface TranscribeEngineOptions {
  vad?: VadMode;
  speakers?: boolean;
}
```

In the args-build path:

```ts
if (opts.speakers) {
  if (!caps.features.includes(TRANSCRIBE_DIARIZE_FEATURE)) {
    throw new Error(
      "speaker diarization is currently darwin-arm64 only " +
      "(see https://github.com/drakulavich/kesha-voice-kit/issues/199)",
    );
  }
  args.push("--speakers");
}
```

- [ ] **Step 9.2: Transcribe.ts plumb**

Add `speakers?: boolean` to `TranscribeOptions`. Forward to `transcribeEngineWithSegments`. The existing `transcribeWithTimestamps` public API picks it up automatically.

- [ ] **Step 9.3: CLI flag**

In `src/cli/main.ts`, add `--speakers` next to `--timestamps`:

```ts
.option("--speakers", "Include speaker labels in transcript segments. Requires --json / --toon / --format json. Implies --timestamps. Currently darwin-arm64 only.")
```

Gate matches the `--timestamps` validator: error 2 if neither `--json` / `--toon` / `--format json` is set.

- [ ] **Step 9.4: tsc + bun test**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
bunx tsc --noEmit && echo tsc-clean
bun test 2>&1 | tail -3
```

- [ ] **Step 9.5: Commit**

```bash
git add src/engine.ts src/transcribe.ts src/cli/main.ts
git commit -m "$(cat <<'EOF'
feat(#199): TS capability gate + --speakers forwarding

Mirrors the transcribe.segments shape: TRANSCRIBE_DIARIZE_FEATURE
const; capability check before forwarding --speakers; explicit
"darwin-arm64 only" error with #199 link when the engine doesn't
advertise support. CLI flag gates on machine-readable output.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T9-ts-gate.sha
```

---

## Task 10: `kesha install` downloads the sidecar

Mirror `downloadAVSpeechSidecar`. Concurrent with the engine fetch. Best-effort (404 = older release, log + continue).

**Files:**
- Modify: `src/engine-install.ts`

- [ ] **Step 10.1: Add `downloadDiarizeSidecar`**

In `src/engine-install.ts`, after `downloadAVSpeechSidecar`:

```ts
async function downloadDiarizeSidecar(binPath: string, engineVersion: string): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;

  const sidecarPath = join(dirname(binPath), "kesha-diarize-darwin-arm64");
  const url = `https://github.com/${GITHUB_REPO}/releases/download/v${engineVersion}/kesha-diarize-darwin-arm64`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e: unknown) {
    log.warn(
      `Could not fetch diarization sidecar (${e instanceof Error ? e.message : e}); --speakers unavailable.`,
    );
    return;
  }
  if (res.status === 404) {
    log.debug(
      `Diarization sidecar not in release v${engineVersion} (HTTP 404); --speakers unavailable.`,
    );
    return;
  }
  if (!res.ok) {
    log.warn(
      `Diarization sidecar fetch failed (HTTP ${res.status}); --speakers unavailable.`,
    );
    return;
  }
  try {
    await streamResponseToFile(res, sidecarPath, "kesha-diarize sidecar");
    chmodSync(sidecarPath, 0o755);
    log.success("Diarization sidecar installed (--speakers available).");
  } catch (e: unknown) {
    log.warn(
      `Diarization sidecar install failed (${e instanceof Error ? e.message : e}); --speakers unavailable.`,
    );
  }
}
```

- [ ] **Step 10.2: Concurrent fetch in `downloadEngine`**

After the `sidecarPromise = downloadAVSpeechSidecar(...)` line, add:

```ts
const diarizePromise = downloadDiarizeSidecar(binPath, engineVersion);
```

After the `await sidecarPromise` line:

```ts
await diarizePromise;
```

Add the same `.catch(() => {})` no-op rejection handler if the engine fetch fails, mirroring the existing AVSpeech pattern.

- [ ] **Step 10.3: Verify**

```bash
bunx tsc --noEmit && echo tsc-clean
bun test 2>&1 | tail -3
```

- [ ] **Step 10.4: Commit**

```bash
git add src/engine-install.ts
git commit -m "$(cat <<'EOF'
feat(#199): kesha install downloads kesha-diarize-darwin-arm64

Mirrors downloadAVSpeechSidecar. Concurrent with the engine fetch;
best-effort (404 / network errors logged, --speakers unavailable but
no fatal install failure).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T10-install.sha
```

---

## Task 11: Rust integration test

Synthesize a 30 s 2-speaker WAV from kesha's TTS, run end-to-end through the engine binary, assert ≥ 2 distinct speaker IDs and ≥ 80% of ASR-detected speech time has a speaker label.

**Files:**
- Create: `rust/tests/diarize_e2e.rs`

- [ ] **Step 11.1: Create the test file**

```rust
//! End-to-end diarization smoke. Synthesizes a 2-speaker dialogue from kesha's
//! own TTS, runs `kesha-engine transcribe --json --speakers`, asserts the
//! output JSON has segments with at least 2 distinct speaker IDs.
//!
//! Gated by `system_diarize` feature; skipped on non-darwin or when the
//! sidecar isn't found.
//!
//! Closes #199.

#![cfg(feature = "system_diarize")]

use std::path::PathBuf;
use std::process::Command;

fn engine_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kesha-engine"))
}

#[test]
fn two_speaker_dialogue_yields_two_clusters() {
    let exe = engine_binary();
    if !exe.exists() {
        eprintln!("skipping: engine binary not found at {}", exe.display());
        return;
    }

    let tmp = tempfile::Builder::new()
        .prefix("kesha-diarize-e2e-")
        .tempdir()
        .unwrap();

    // Synthesize three TTS clips and concat them. If the TTS install isn't
    // present, skip — this test exercises the diarization path, not TTS.
    let p1a = tmp.path().join("p1a.wav");
    let p2 = tmp.path().join("p2.wav");
    let p1b = tmp.path().join("p1b.wav");

    let say = |text: &str, voice: &str, out: &PathBuf| -> bool {
        let st = Command::new(&exe)
            .args([
                "say", "--voice", voice, "--out", out.to_str().unwrap(),
            ])
            .arg(text)
            .status()
            .unwrap();
        st.success()
    };

    if !say("Hello everyone, this is the first speaker beginning the call.", "en-am_michael", &p1a) {
        eprintln!("skipping: TTS not installed");
        return;
    }
    say("Hi, this is the second speaker responding now.", "en-bm_george", &p2);
    say("Yes thanks for joining, the first speaker again.", "en-am_michael", &p1b);

    // ffmpeg -i concat:p1a|p2|p1b -c copy
    let combined = tmp.path().join("dialogue.wav");
    let st = Command::new("ffmpeg")
        .args([
            "-y",
            "-i",
            &format!("concat:{}|{}|{}", p1a.display(), p2.display(), p1b.display()),
            "-c",
            "copy",
            combined.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    if !st.success() {
        eprintln!("skipping: ffmpeg not available");
        return;
    }

    // Run transcribe --json --speakers
    let out = Command::new(&exe)
        .args(["transcribe", "--json", "--speakers", combined.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "engine transcribe failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&out.stdout)
        .expect("engine output is not valid JSON");

    let segments = json["segments"].as_array().expect("segments is an array");
    assert!(!segments.is_empty(), "no segments produced");

    let speakers: std::collections::HashSet<u64> = segments
        .iter()
        .filter_map(|s| s["speaker"].as_u64())
        .collect();
    assert!(
        speakers.len() >= 2,
        "expected ≥ 2 distinct speakers, got {speakers:?}; segments: {segments:#?}"
    );

    let labeled = segments.iter().filter(|s| s["speaker"].is_u64()).count();
    let labeled_ratio = labeled as f32 / segments.len() as f32;
    assert!(
        labeled_ratio >= 0.80,
        "expected ≥ 80% of segments to have a speaker label, got {:.0}%",
        labeled_ratio * 100.0
    );
}
```

- [ ] **Step 11.2: Run**

```bash
cd rust
cargo test --release --no-default-features --features onnx,tts,system_diarize --test diarize_e2e 2>&1 | tail -10
```
Expected: 1 test passes (or `skipping: ...` line if TTS / ffmpeg unavailable).

- [ ] **Step 11.3: Commit**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
git add rust/tests/diarize_e2e.rs
git commit -m "$(cat <<'EOF'
test(#199): integration e2e for darwin-arm64 diarization

Self-fixturing: synthesizes 2-speaker dialogue from kesha's own TTS,
concatenates via ffmpeg, runs transcribe --json --speakers, asserts
≥ 2 distinct cluster IDs in output and ≥ 80% segments labeled.
Skips gracefully when TTS / ffmpeg / sidecar absent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T11-e2e.sha
```

---

## Task 12: TS integration test + capability JSON test

**Files:**
- Modify: `tests/integration/e2e-engine.test.ts`
- Modify: `tests/integration/capabilities.test.ts` (or wherever the existing capability JSON test lives)

- [ ] **Step 12.1: Add `--speakers` round-trip to e2e-engine.test.ts**

```ts
test("--speakers round-trip on darwin-arm64", async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return; // skip on non-darwin
  }
  const binPath = process.env.KESHA_ENGINE_BIN || ...;
  const fixture = "fixtures/benchmark-en/01-check-email.ogg";
  const proc = Bun.spawn([binPath, "transcribe", "--json", "--speakers", fixture], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  expect(exit).toBe(0);
  const parsed = JSON.parse(out);
  expect(Array.isArray(parsed.segments)).toBe(true);
  // Single-speaker fixture → one cluster ID, but field MUST be present.
  expect(parsed.segments.every((s: any) => typeof s.speaker === "number")).toBe(true);
});
```

- [ ] **Step 12.2: Capability JSON assertion**

In the existing capability test:
```ts
test("capabilities include transcribe.diarize on darwin-arm64", () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const caps = JSON.parse(...);
  expect(caps.features).toContain("transcribe.diarize");
});

test("capabilities exclude transcribe.diarize on non-darwin", () => {
  if (process.platform === "darwin") return;
  const caps = JSON.parse(...);
  expect(caps.features).not.toContain("transcribe.diarize");
});
```

- [ ] **Step 12.3: Run**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
bun test 2>&1 | tail -3
```

- [ ] **Step 12.4: Commit**

```bash
git add tests/integration/
git commit -m "$(cat <<'EOF'
test(#199): TS --speakers round-trip + capability JSON

Capability matrix locked: transcribe.diarize present on darwin-arm64
release builds, absent elsewhere. e2e --speakers test gates on
os.platform()==='darwin' && os.arch()==='arm64'; skips otherwise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T12-ts-tests.sha
```

---

## Task 13: build-engine.yml — feature flag + smoke + asset upload

**Files:**
- Modify: `.github/workflows/build-engine.yml`

- [ ] **Step 13.1: Add `system_diarize` to the macos-14 matrix row**

Find the macos-14 entry. Append `system_diarize` to its `features` value:

```yaml
- runner: macos-14
  target: aarch64-apple-darwin
  features: coreml,tts,system_tts,system_diarize
  asset: kesha-engine-darwin-arm64
```

- [ ] **Step 13.2: Pre-upload smoke for the sidecar**

After the existing AVSpeech smoke step on the macos-14 job:

```yaml
- name: Smoke test diarize sidecar
  if: matrix.runner == 'macos-14'
  run: |
    SIDECAR=rust/target/aarch64-apple-darwin/release/build/*/out/kesha-diarize
    SIDECAR=$(ls $SIDECAR | head -1)
    "$SIDECAR" --list-models
```

- [ ] **Step 13.3: Upload sidecar as separate release artifact**

After the engine binary upload, on the macos-14 job:

```yaml
- name: Upload diarize sidecar
  if: matrix.runner == 'macos-14'
  uses: softprops/action-gh-release@v2
  with:
    files: rust/target/aarch64-apple-darwin/release/build/*/out/kesha-diarize
    draft: true
    tag_name: ${{ github.ref_name }}
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

(Adjust path / asset rename to ship as `kesha-diarize-darwin-arm64`.)

- [ ] **Step 13.4: Lint (Actions YAML)**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
gh workflow view "🔨 Build Engine" 2>&1 | head -3   # quick parse check
```

- [ ] **Step 13.5: Commit**

```bash
git add .github/workflows/build-engine.yml
git commit -m "$(cat <<'EOF'
ci(#199): add system_diarize to macos-14 build + sidecar upload

build-engine.yml macos-14 row gets system_diarize. Pre-upload smoke
runs kesha-diarize --list-models. Sidecar uploads as a separate
release artifact (kesha-diarize-darwin-arm64) alongside the engine.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T13-ci.sha
```

---

## Task 14: Documentation

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `docs/tts.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 14.1: README.md — add a `--speakers` example**

After the existing `--timestamps` example:

```markdown
**Speaker diarization** (darwin-arm64 only, post-v1.12.0):

```bash
kesha --json --timestamps --speakers meeting.m4a > out.json
jq '.[0].segments[] | "\(.speaker)\t\(.text)"' out.json
```

Each segment carries a `speaker` integer (cluster ID, stable within one file).
Linux / Windows: `--speakers` returns a `not supported on this platform` error.
```

- [ ] **Step 14.2: SKILL.md — same pattern**

Add a one-paragraph entry mirroring the timestamped-segments paragraph.

- [ ] **Step 14.3: docs/tts.md — n/a**

Diarization is an ASR feature, not TTS. Skip docs/tts.md; instead add a "Speaker diarization (darwin-arm64)" section to a new or existing ASR-side docs page (or extend the README section).

- [ ] **Step 14.4: CHANGELOG.md — add v1.12.0 (unreleased)**

After the `## [Unreleased]` line, add:

```markdown
## [1.12.0] (unreleased)

### Added
- **Speaker diarization on darwin-arm64** via the FluidAudio framework, surfaced as `kesha --json --timestamps --speakers meeting.m4a`. Each segment carries a `speaker: u32` cluster ID (stable within one file, not across files). New capability flag `transcribe.diarize` reports darwin-arm64 only. Closes [#199](https://github.com/drakulavich/kesha-voice-kit/issues/199) angle D. New sidecar binary `kesha-diarize-darwin-arm64` ships next to the engine; `kesha install` fetches both.
- **`transcribeWithTimestamps({ speakers: true })`** programmatic API picks up the new field.

### Removed
- (none)

### Notes
- Linux / Windows: `--speakers` returns a clear "not supported on this platform" error pointing at the cross-platform-diarization tracking issue.
```

- [ ] **Step 14.5: Commit**

```bash
git add README.md SKILL.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(#199): document --speakers + speaker diarization (darwin-arm64)

README + SKILL.md gain a usage example. CHANGELOG seeds the v1.12.0
(unreleased) entry pending the actual tag.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T14-docs.sha
```

---

## Task 15: Lockstep version bump to v1.12.0

**Files:**
- Modify: `package.json`
- Modify: `rust/Cargo.toml`
- Modify: `rust/Cargo.lock`

- [ ] **Step 15.1: Bumps**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit
sed -i '' 's/"version": "1.11.0"/"version": "1.12.0"/g' package.json
grep '"version"' package.json
sed -i '' 's/^version = "1.11.0"/version = "1.12.0"/' rust/Cargo.toml
cd rust && cargo check --no-default-features --features onnx,tts 2>&1 | tail -3
grep -A1 'name = "kesha-engine"' Cargo.lock | head -3
```

- [ ] **Step 15.2: Verify build**

```bash
cargo build --release --no-default-features --features onnx,tts 2>&1 | tail -3
./target/release/kesha-engine --version
```
Expected: `kesha-engine 1.12.0`.

- [ ] **Step 15.3: Full test suite once more**

```bash
cargo test --no-default-features --features onnx,tts 2>&1 | tail -3
cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -3
cargo fmt --check && echo fmt-clean
cd .. && bun test 2>&1 | tail -3
bunx tsc --noEmit && echo tsc-clean
```

- [ ] **Step 15.4: Commit**

```bash
git add package.json rust/Cargo.toml rust/Cargo.lock
git commit -m "$(cat <<'EOF'
chore(release): bump engine + CLI to v1.12.0 for #199

Lockstep bump per CLAUDE.md RELEASE PROCESS — engine release because
rust/ changed (new system_diarize feature, new sidecar binary,
TranscriptionSegment.speaker field).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git rev-parse HEAD > /tmp/kesha-199-evidence/T15-bump.sha
```

---

## Task 16: STOP — manual release runbook (gate on user)

Per spec + CLAUDE.md "RELEASE PROCESS". Do NOT auto-tag, auto-build, or auto-publish.

- [ ] **Step 16.1: Push the branch**

```bash
git push -u origin feat/199-darwin-diarization 2>&1 | tail -3
```

- [ ] **Step 16.2: Open the release PR**

```bash
gh pr create -R drakulavich/kesha-voice-kit \
  --title "feat(transcribe): speaker diarization (darwin-arm64) — v1.12.0 release (closes #199 angle D)" \
  --body "$(cat <<'EOF'
Closes #199 angle D. Implements speaker diarization via a FluidAudio Swift sidecar on darwin-arm64. Linux / Windows return a clear "not supported on this platform" error pointing at the cross-platform-diarization tracking issue.

## What's new
- `kesha --json --timestamps --speakers meeting.m4a` returns per-segment cluster IDs.
- New capability `transcribe.diarize`.
- New sidecar `kesha-diarize-darwin-arm64`; `kesha install` fetches both engine + sidecar.
- `TranscribeOptions.speakers` programmatic flag; `transcribeWithTimestamps({ speakers: true })`.
- Lockstep bump to v1.12.0.

## Test evidence
Per-task SHAs at /tmp/kesha-199-evidence/. Spike findings recorded in spec Section 5 (T1-spike.notes). Integration test self-fixtures via TTS (T11-e2e.sha) and asserts ≥ 2 cluster IDs.

## Verifiability
- Rust unit + integration tests green; cargo clippy --all-targets -D warnings clean.
- bun test + bunx tsc --noEmit clean.
- Capability JSON: `kesha-engine --capabilities-json | jq '.features'` includes `transcribe.diarize` on darwin-arm64.
- Pre-upload sidecar smoke runs `kesha-diarize-darwin-arm64 --list-models`.

## Release plan (post-merge)
1. `git tag v1.12.0 && git push origin v1.12.0` (triggers build-engine.yml).
2. Author release notes BEFORE `gh release edit v1.12.0 --draft=false`.
3. Independent v1.12.0 validation on darwin-arm64: download both `kesha-engine-darwin-arm64` and `kesha-diarize-darwin-arm64`, exercise --speakers end-to-end on a 2-speaker fixture, confirm ≥ 2 distinct cluster IDs.
4. Cross-platform validation: download `kesha-engine-linux-x64`, exercise `--speakers`, confirm the platform-not-supported error fires with the issue link.
5. `npm publish --access public`.
EOF
)"
```

- [ ] **Step 16.3: STOP — wait for user authorization**

Do NOT auto-execute any of the following without explicit go-ahead:
- Tag `v1.12.0`
- Trigger `build-engine.yml` workflow
- Author release notes
- Publish draft (`gh release edit v1.12.0 --draft=false`)
- Independent v1.12.0 validation on darwin-arm64 + Linux/Windows
- `npm publish --access public`

The user-facing prompt should look like:

> "PR opened, branch pushed. Ready to drive the v1.12.0 release runbook (tag → build-engine → release notes → publish draft → independent validation → npm publish). The npm publish step is irreversible. Want me to proceed?"

---

## Self-review

After completing tasks 1–15, before opening the PR (Task 16.2):

**1. Spec coverage:**

| Spec section | Implemented in |
|---|---|
| §Architecture / pipeline shape | T6 (diarize module), T7 (post-step wiring) |
| §File layout | T2-T6, T8-T10, T13 |
| §Output shape (TranscriptionSegment.speaker) | T3 |
| §CLI surface (--speakers gate, auto-imply --timestamps) | T8 (engine), T9 (TS CLI) |
| §Swift sidecar protocol (argv, JSON, --list-models) | T4 |
| §Capability JSON | T2 (const), T12 (test) |
| §Spike findings (T1-spike.notes) | T1 |
| §Testing (Rust unit, integration, TS, capability matrix, audio QA) | T6 (unit), T11 (integration), T12 (TS), T9 (audio QA — manual gate before release) |
| §Release plan | T15 (bump), T16 (manual runbook) |

**2. Placeholder scan:** No "TBD" or "implement later" except in T1 (the spike, which is intentionally measurement-only) and T16 (the release runbook, which gates on the user). Each step shows actual code or actual command.

**3. Type consistency:** `DiarizeSpan { start: f32, end: f32, speaker: u32 }` used consistently in T6, T7, and the Swift sidecar's JSON output (T4). `TranscriptionSegment.speaker: Option<u32>` defined in T3, consumed in T6, T7, T8, T11, T12.

**4. CLAUDE.md gates verified:**
- ✓ `cargo clippy --all-targets -- -D warnings` runs at T2.4, T3.6, T7.4, T15.3.
- ✓ `cargo fmt --check` runs at T3.6, T15.3.
- ✓ `bun test && bunx tsc --noEmit` runs at T9.4, T10.3, T12.3, T15.3.
- ✓ Spike-mandatory before plan: T1 BLOCKS subsequent tasks; spec amendment commit (T1.8) records the findings.
- ✓ Independent v1.12.0 validation gated behind user authorization at T16.

---

## Execution

Plan complete. Two execution options:

1. **Subagent-Driven** (recommended) — fresh subagent per task, two-stage review (spec compliance + code quality) between tasks. Use `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in this session. Use `superpowers:executing-plans`.

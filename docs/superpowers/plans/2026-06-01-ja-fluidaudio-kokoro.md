# Japanese TTS via FluidAudio 0.14.8 KokoroAne — Implementation Plan (#492)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native Japanese TTS on the darwin FluidAudio Kokoro path by bumping the fork to FluidAudio 0.14.8 and selecting the `KokoroAne` variant by language (en/es/ja).

**Architecture:** Two repos, sequenced. Phase A edits the `drakulavich/fluidaudio-rs` fork (Swift bridge + FFI) so `init_kokoro` picks the `KokoroAneVariant` from a `lang` argument; publishes a new rev. Phase B bumps kesha's rev, threads the voice's language into the bridge init, and unblocks `ja` native script. `hi`/`zh` stay fail-fast.

**Tech Stack:** Swift 6 / SwiftPM (FluidAudio 0.14.8), Rust FFI (`fluidaudio-rs`), Rust (kesha `tts::fluid_kokoro`), `cargo nextest`. **macOS arm64 only** (`system_kokoro` / Xcode).

**Design doc:** `docs/superpowers/specs/2026-06-01-ja-fluidaudio-kokoro-design.md`

**Spec refinement (intentional):** the spec proposed threading `lang` through `synthesizeKokoro`; this plan threads it through **`init_kokoro`** instead, because `KokoroAneManager`'s variant is fixed at construction (bridge `FluidAudioBridge.swift:140`) and kesha's `with_kokoro` re-inits the bridge per call. Same outcome ("variant selected by language"), correct lever.

**Repos & working dirs:**
- Fork: `/Users/anton/Personal/repos/fluidaudio-rs` — base branch `feat/fluidaudio-0.14.7-kokoro-ane-speed` (has the KokoroAneManager migration + `--rate`); work on a new branch `feat/fluidaudio-0.14.8-multilingual-variants`.
- kesha: `.worktrees/ja-fluidaudio` (branch `feat/ja-fluidaudio-kokoro`).

**Build-loop caveat:** Phase A is iterative Swift work against a real API. Steps A1/A2 are "edit → `swift build` → read errors → adapt" — the exact `KokoroAneManager` init signature and `KokoroAneVariant` case spellings in 0.14.8 must be confirmed from the compiler/source, not assumed. The variant cases were observed as `.english` / `.spanish` / `.japanese` (raw values `"en"`/`"es"`/`"ja"`) in the FluidAudio 0.14.8 source.

---

## PHASE A — fork: `drakulavich/fluidaudio-rs`

### Task A1: Bump FluidAudio to 0.14.8 and establish the build baseline

**Files:** `Package.swift` (FluidAudio pin)

- [ ] **Step 1: Branch off the KokoroAne base**
```bash
cd /Users/anton/Personal/repos/fluidaudio-rs
git fetch origin
git switch feat/fluidaudio-0.14.7-kokoro-ane-speed
git switch -c feat/fluidaudio-0.14.8-multilingual-variants
```

- [ ] **Step 2: Bump the FluidAudio pin**

In `Package.swift`, change the FluidAudio dependency:
```swift
.package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.14.8"),
```
(from `exact: "0.14.7"`).

- [ ] **Step 3: Resolve + build to surface the API delta**
```bash
swift package resolve
swift build 2>&1 | tee /tmp/fa-build.log
```
Expected: either a clean build (0.14.7→0.14.8 is API-compatible for the paths we use) **or** compile errors in `swift/FluidAudioBridge.swift` around `KokoroAneManager`. **Read the errors** — they define exactly what Task A2 must adapt. Do not guess; if `KokoroAneManager(variant:defaultVoice:)` changed, note the new signature from the error/source before proceeding.

- [ ] **Step 4: Commit the bump (even if the bridge still hardcodes English)**
```bash
git add Package.swift Package.resolved
git commit -m "build: bump FluidAudio 0.14.7 -> 0.14.8"
```

### Task A2: Select the KokoroAne variant by language in the bridge

**Files:** `swift/FluidAudioBridge.swift` (`initializeKokoro`, ~lines 132-155, and the stored `kokoroManager`)

- [ ] **Step 1: Add a lang→variant mapping helper**

Add to `FluidAudioBridge` (near `initializeKokoro`). Confirm the exact `KokoroAneVariant` case names compile (observed: `.english`, `.spanish`, `.japanese`):
```swift
/// Map a kesha/espeak-style language tag to a KokoroAne variant. FluidAudio
/// 0.14.8 ships english/spanish/japanese variants; anything else (incl. empty)
/// falls back to English so existing en voices are unaffected.
private static func kokoroVariant(for lang: String) -> KokoroAneVariant {
    let base = lang.lowercased().split(separator: "-").first.map(String.init) ?? ""
    switch base {
    case "ja": return .japanese
    case "es": return .spanish
    default:   return .english
    }
}
```

- [ ] **Step 2: Thread `lang` into `initializeKokoro` and pick the variant**

Change the signature and the hardcoded `.english`:
```swift
func initializeKokoro(defaultVoice: String, lang: String) throws {
    let semaphore = DispatchSemaphore(value: 0)
    var initError: Error?
    Task {
        do {
            let variant = Self.kokoroVariant(for: lang)
            let manager = KokoroAneManager(variant: variant, defaultVoice: defaultVoice)
            try await manager.initialize(preloadVoices: [defaultVoice])
            self.kokoroManager = manager
        } catch {
            initError = error
        }
        semaphore.signal()
    }
    semaphore.wait()
    if let error = initError { throw error }
}
```
(`synthesizeKokoro` is unchanged — it uses the now variant-correct `kokoroManager`.)

- [ ] **Step 3: Build**
```bash
swift build 2>&1 | tail -20
```
Expected: clean. If `KokoroAneManager.initialize(preloadVoices:)` rejects a Japanese voice id at init, adjust `preloadVoices` (e.g. preload nothing or the variant's default) per the error — record what you changed.

### Task A3: Thread `lang` through the FFI (Swift FFI → Rust binding)

**Files:** `swift/Kokoro_ffi.swift` (`fluidaudio_initialize_kokoro`), `src/ffi/bridge.rs` (extern + `initialize_kokoro`), `src/lib.rs` (`init_kokoro`)

- [ ] **Step 1: Add `lang` to the Swift FFI init**

In `swift/Kokoro_ffi.swift`, `fluidaudio_initialize_kokoro` currently takes `(ptr, defaultVoice)`. Add a `lang` C-string param and pass it through:
```swift
@_cdecl("fluidaudio_initialize_kokoro")
public func fluidaudio_initialize_kokoro(
    _ ptr: UnsafeMutableRawPointer?,
    _ defaultVoice: UnsafePointer<CChar>?,
    _ lang: UnsafePointer<CChar>?
) -> Int32 {
    guard let ptr = ptr, let defaultVoice = defaultVoice else { return -1 }
    let bridge = Unmanaged<FluidAudioBridge>.fromOpaque(ptr).takeUnretainedValue()
    let voiceString = String(cString: defaultVoice)
    let langString = lang.map { String(cString: $0) } ?? ""
    do {
        try bridge.initializeKokoro(defaultVoice: voiceString, lang: langString)
        return 0
    } catch {
        print("Kokoro init error: \(error)")
        return -1
    }
}
```
(Match the existing function's exact error/return style — copy its current body and add the `lang` decode + pass-through.)

- [ ] **Step 2: Update the Rust extern + wrapper in `src/ffi/bridge.rs`**

Update the `extern "C"` declaration for `fluidaudio_initialize_kokoro` to add `lang: *const c_char`, and update `initialize_kokoro`:
```rust
pub fn initialize_kokoro(&self, default_voice: &str, lang: &str) -> Result<(), String> {
    let c_voice = CString::new(default_voice).map_err(|e| e.to_string())?;
    let c_lang = CString::new(lang).map_err(|e| e.to_string())?;
    let rc = unsafe {
        fluidaudio_initialize_kokoro(self.ptr, c_voice.as_ptr(), c_lang.as_ptr())
    };
    if rc == 0 { Ok(()) } else { Err("kokoro init failed".into()) }
}
```
(Adapt to the file's existing CString/error idioms — keep them.)

- [ ] **Step 3: Update `src/lib.rs` `init_kokoro`**
```rust
pub fn init_kokoro(&self, default_voice: &str, lang: &str) -> Result<(), FluidAudioError> {
    self.bridge
        .initialize_kokoro(default_voice, lang)
        .map_err(FluidAudioError::Kokoro)
}
```
(Match the existing error-wrapping; only the added `lang` param is new.)

- [ ] **Step 4: Build the Rust binding**
```bash
cargo build 2>&1 | tail -15
```
Expected: clean.

### Task A4: Validate Japanese synthesis + publish the rev

- [ ] **Step 1: Smoke-test Japanese end-to-end**

Write a throwaway example `examples/ja_smoke.rs` (do not keep) that inits Kokoro with a Japanese voice + `lang="ja"` and synthesizes こんにちは, asserting a non-empty WAV:
```rust
fn main() {
    let a = fluidaudio_rs::FluidAudio::new().unwrap();
    a.init_kokoro("jm_kumo", "ja").unwrap();
    let wav = a.synthesize_kokoro("こんにちは", "jm_kumo", 1.0).unwrap();
    assert!(wav.len() > 1000, "empty/short WAV: {}", wav.len());
    eprintln!("ja WAV bytes: {}", wav.len());
}
```
```bash
cargo run --example ja_smoke 2>&1 | tail -5
rm examples/ja_smoke.rs
```
Expected: non-empty WAV, no error. (If the JA model/assets download on first init, allow it — note the size.) Also re-run with `init_kokoro("am_michael","en-us")` to confirm English is unregressed.

- [ ] **Step 2: Verify `--rate` still feeds the model across variants**

Synthesize the same JA text at `speed: 0.7` and `1.3`; confirm the WAV durations differ (rate applied). Record the observation.

- [ ] **Step 3: Commit + push**
```bash
git add -A
git commit -m "feat: select KokoroAne variant by language (en/es/ja) on FluidAudio 0.14.8"
git push -u origin feat/fluidaudio-0.14.8-multilingual-variants
git rev-parse HEAD   # record this SHA for Phase B
```

- [ ] **Step 4: Open the fork PR**
```bash
gh pr create -R drakulavich/fluidaudio-rs --base forked-main \
  --head feat/fluidaudio-0.14.8-multilingual-variants \
  --title "feat: FluidAudio 0.14.8 + KokoroAne variant selection (en/es/ja)" \
  --body "Bumps FluidAudio 0.14.7→0.14.8 and selects the KokoroAne variant by language in initializeKokoro (threaded via a new lang FFI arg). Unblocks Japanese (and Spanish) native synthesis on the ANE Kokoro path; English unchanged. Preserves the --rate model-native speed input. For kesha-voice-kit #492."
```

---

## PHASE B — kesha-voice-kit (`feat/ja-fluidaudio-kokoro`)

> Prerequisite: Phase A rev SHA (call it `<FORK_SHA>`). Phase B does not build green on darwin until the fork rev is pushed.

### Task B1: Bump the fluidaudio-rs rev

**Files:** `rust/Cargo.toml:72-78`

- [ ] **Step 1: Point at the new fork commit**

Update the `fluidaudio-rs` dep `rev` to `<FORK_SHA>` and refresh the comment to note FluidAudio 0.14.8 + per-language KokoroAne variant selection. Then:
```bash
cd rust && cargo update -p fluidaudio-rs 2>&1 | tail -5
```

- [ ] **Step 2: Commit**
```bash
git add rust/Cargo.toml rust/Cargo.lock
git commit -m "build(tts): bump fluidaudio-rs to FluidAudio 0.14.8 multilingual variants (#492)"
```

### Task B2: Thread the voice's language into `init_kokoro`

**Files:** `rust/src/tts/fluid_kokoro.rs` (`with_kokoro`, ~line 249)

- [ ] **Step 1: Resolve the lang in `with_kokoro` and pass it to init**

`lang_for_fluid_id(fluid_id)` (defined ~line 188) returns the voice's lang. Update `with_kokoro`:
```rust
fn with_kokoro<R>(voice_id: &str, f: impl FnOnce(&FluidAudio) -> Result<R>) -> Result<R> {
    let lang = lang_for_fluid_id(voice_id).unwrap_or("en-us");
    crate::fluid_stdout::with_silenced_stdout_oneshot(|| {
        let audio = FluidAudio::new().context("init FluidAudio bridge")?;
        audio
            .init_kokoro(voice_id, lang)
            .context("init FluidAudio Kokoro (downloads the model on first run)")?;
        f(&audio)
    })
}
```

- [ ] **Step 2: Build (darwin, system_kokoro)**
```bash
cd rust && cargo build --features system_kokoro --no-default-features 2>&1 | tail -10
```
Expected: clean (the binding's `init_kokoro` now takes 2 args).

- [ ] **Step 3: Commit**
```bash
git add rust/src/tts/fluid_kokoro.rs
git commit -m "feat(tts): pass voice language to FluidAudio Kokoro init for variant selection (#492)"
```

### Task B3: Unblock `ja` native script (keep hi/zh fail-fast)

**Files:** `rust/src/tts/fluid_kokoro.rs` (`unsupported_native_script`, ~line 214) + its test

- [ ] **Step 1: Update the gate test first (TDD)**

Find the existing `flags_native_script_for_non_latin_voices` test (~line 362). Change its expectations so `ja` (kana/kanji) is now **allowed** while `hi`/`zh` still flag. Concretely, assert:
```rust
// ja native script now synthesizes (FluidAudio 0.14.8 Japanese KokoroAne variant).
assert_eq!(unsupported_native_script("こんにちは", "jm_kumo"), None);
// hi/zh remain unsupported until their variants ship in a FluidAudio release.
assert_eq!(unsupported_native_script("नमस्ते", "hm_omega"), Some("Devanagari"));
assert_eq!(unsupported_native_script("你好", "zm_yunjian"), Some("Chinese (Han)"));
```
(Keep any existing Latin-passes-through assertions.)

- [ ] **Step 2: Run the test → expect FAIL**
```bash
cd rust && cargo nextest run --features system_kokoro --no-default-features fluid_kokoro 2>&1 | tail -8
```
Expected: FAIL — `ja` still returns `Some("Japanese (kana/kanji)")`.

- [ ] **Step 3: Drop the `ja` arm from `unsupported_native_script`**
```rust
fn unsupported_native_script(text: &str, fluid_id: &str) -> Option<&'static str> {
    let any = |f: fn(char) -> bool| text.chars().any(f);
    match lang_for_fluid_id(fluid_id)? {
        "hi" => any(|c| ('\u{0900}'..='\u{097F}').contains(&c)).then_some("Devanagari"),
        // ja (kana/kanji) is supported via FluidAudio 0.14.8's Japanese KokoroAne
        // variant (#492). zh remains noise until a release ships the mandarin variant.
        "zh" => any(is_han).then_some("Chinese (Han)"),
        _ => None,
    }
}
```
Update the doc comment above it to say hi/zh (not hi/ja/zh).

- [ ] **Step 4: Run the test → PASS**
```bash
cd rust && cargo nextest run --features system_kokoro --no-default-features fluid_kokoro 2>&1 | tail -8
```

- [ ] **Step 5: Commit**
```bash
git add rust/src/tts/fluid_kokoro.rs
git commit -m "feat(tts): allow Japanese native script on FluidAudio Kokoro; keep hi/zh fail-fast (#492)"
```

### Task B4: Confirm the Japanese default voice is male

**Files:** `rust/src/tts/voices.rs` (`resolve_fluid_kokoro` / default for `ja`)

- [ ] **Step 1: Verify `--voice` resolution + the auto-default for `ja`**

`ja-jm_kumo` (lang `ja`, `jm_` = male) already exists in the `fluid_kokoro` VOICES table. Confirm `resolve_voice("ja-jm_kumo")` resolves and that the `ja` auto-route default (when `--voice` omitted) is a `jm_*` male voice, per CLAUDE.md "DEFAULT TTS VOICES MUST BE MALE". Add/adjust a small unit test if a default mapping exists:
```rust
#[test]
fn japanese_default_voice_is_male() {
    // brand rule: ja default must be a male (jm_*) voice
    let v = super::resolve_voice("ja-jm_kumo").expect("ja-jm_kumo present");
    assert!(v.fluid_id.starts_with("jm_"), "ja default not male: {}", v.fluid_id);
}
```
If `pickVoiceForLang`/`default_voice_for_lang` has a `ja` entry, assert it points at a `jm_*` voice; if it's missing, add it pointing at `jm_kumo`.

- [ ] **Step 2: Run + commit**
```bash
cd rust && cargo nextest run --features system_kokoro --no-default-features japanese_default 2>&1 | tail -5
git add rust/src/tts/voices.rs rust/src/tts/fluid_kokoro.rs
git commit -m "test(tts): assert Japanese default voice is male (#492)"
```

### Task B5: Japanese round-trip + audio QC + docs

**Files:** a darwin-gated test (e.g. `rust/tests/`), `CLAUDE.md`, `docs/runbooks/tts-internals.md`

- [ ] **Step 1: Build the engine + synthesize Japanese**
```bash
cd rust && cargo build --features system_kokoro --no-default-features --bin kesha-engine
./target/debug/kesha-engine say --voice ja-jm_kumo "こんにちは。私の名前はケシャです。" --out /tmp/ja.wav 2>/tmp/ja.err
cat /tmp/ja.err   # should be progress only, no ScriptUnsupported error
afinfo /tmp/ja.wav | grep -i 'duration\|format'
```
Expected: a real WAV, no `E_SCRIPT_UNSUPPORTED`.

- [ ] **Step 2: Round-trip via ASR + audio-quality-check**

Transcribe the synth output and confirm recognizable Japanese (the #492 evidence method), and run the `audio-quality-check` agent on `/tmp/ja.wav` (rate/RMS/clip/length). Record both in the PR body. (This is a manual/controller verification step, not a committed test, because it needs the ANE + models.)

- [ ] **Step 3: Update docs**

In `CLAUDE.md` TTS section, update the FluidAudio multilingual note: Japanese (kana/kanji) now synthesizes natively via FluidAudio 0.14.8's KokoroAne Japanese variant; hi/zh still fail-fast (`E_SCRIPT_UNSUPPORTED`) pending a FluidAudio release with those variants. In `docs/runbooks/tts-internals.md`, document the `init_kokoro(voice, lang)` → variant-selection flow and the en/es/ja variant map.

- [ ] **Step 4: Commit**
```bash
git add CLAUDE.md docs/runbooks/tts-internals.md
git commit -m "docs(tts): document Japanese FluidAudio Kokoro support (#492)"
```

### Task B6: Final gate + PR

- [ ] **Step 1: Full verification (darwin)**
```bash
cd rust && cargo fmt && cargo clippy --all-targets --features system_kokoro --no-default-features -- -D warnings
cargo nextest run --features system_kokoro --no-default-features
# default ONNX build must also stay green:
cargo nextest run --features tts
```
All pass.

- [ ] **Step 2: Open the kesha PR**
```bash
gh pr create --base main --head feat/ja-fluidaudio-kokoro \
  --title "feat(tts): native Japanese TTS via FluidAudio 0.14.8 KokoroAne (#492)" \
  --body "Refs #492 (ships ja; hi/zh remain tracked). Bumps the fluidaudio-rs fork to FluidAudio 0.14.8 + per-language KokoroAne variant selection (fork PR: <link>), threads the voice language into init, and unblocks ja native script. hi/zh keep the #495 fail-fast. Includes ja round-trip + audio-quality-check evidence."
```
Use `Refs #492` (NOT `Closes` — hi/zh remain). Add the `WIP` label on start; after merge, comment on #492 that ja is supported.

---

## Self-review notes

- **Spec coverage:** fork bump (A1) ✓, variant-by-language (A2) ✓, FFI thread (A3) ✓, `--rate` preserved (A2/A4 Step 2) ✓, rev bump (B1) ✓, lang→init (B2) ✓, relax gate keep hi/zh (B3) ✓, male ja default (B4) ✓, assets via install (B5 Step 1 note) ✓, tests/docs (B5) ✓, Refs-not-Closes (B6) ✓.
- **Build-discovery steps** (A1 Step 3, A2 Step 3) are explicitly "build → read errors → adapt" because the exact 0.14.8 `KokoroAneManager` API can only be confirmed against the compiler; the variant case names (`.english`/`.spanish`/`.japanese`) were observed in the 0.14.8 source but must compile.
- **hi/zh** intentionally untouched (still fail-fast) — out of scope per spec.

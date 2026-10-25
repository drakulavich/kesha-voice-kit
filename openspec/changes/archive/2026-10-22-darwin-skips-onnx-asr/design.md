## Context

`models::install` builds one manifest for every build:

```rust
let manifest: Vec<&ModelFile> = ASR_FILES.iter().chain(LANG_ID_FILES.iter()).collect();
```

`ASR_FILES` has no `cfg`, so it compiles into the CoreML binary too, and
`create_backend`'s coreml arm discards the directory it names (`let _ = model_dir;`).
`lang_id.rs` only ever asks for `ModelKind::LangId`. Nothing on that build reads
`models/parakeet-tdt-v3`.

The directory is nevertheless load-bearing in one place: `transcribe::ensure_asr_installed`
gates Transcription on `is_cached(ModelKind::Asr)`. On darwin that check is not protecting
against a missing model — FluidAudio fetches its own bundle at warm-up (or at first use under
`--no-warmup`) — it is acting as a proxy for "the user ran `kesha install`".

## Goals / Non-Goals

**Goals:**

- A macOS install downloads only what its Backend can read.
- What `--plan` promises equals what the platform downloads.
- A healthy macOS install reports healthy in `status` and `doctor`.
- No change to Linux/Windows behaviour whatsoever.

**Non-Goals:**

- Changing how or when FluidAudio fetches its ASR bundle.
- Hash-pinning that bundle (it is fetched by the Swift library, not by `download_verified`).
- The CharsiuG2P set darwin also over-downloads — same class, separate change.

## Decisions

### D1 — Gate the manifest, not the `ModelKind`

`ASR_FILES` and its two uses (`install`'s manifest, `is_cached_in`'s `Asr` arm) become
`#[cfg(not(feature = "coreml"))]`. `ModelKind::Asr`, `model_dir(Asr)` and the enum stay — they
remain meaningful on ONNX builds and are referenced by the warm-up call path on both.

Gating the const is required, not cosmetic: under `-D warnings`, an `ASR_FILES` left unreferenced
on the coreml build is a `dead_code` error (CLAUDE.md NO SPECULATIVE FIELDS).

*Alternative considered:* a runtime `if cfg!(feature = "coreml")` inside `install`. Rejected —
it leaves the 5-entry const compiled into a binary that can never use it, and `cfg!` would not
silence `dead_code` anyway.

### D2 — On CoreML, Transcription's pre-flight asks FluidAudio's question

`ensure_asr_installed` keeps its contract — *refuse with an actionable hint rather than
download* — but on a coreml build it checks FluidAudio's external cache instead of the ONNX
directory.

This is deliberately **not** a behaviour change for the user, and that is worth stating
precisely: today, a darwin user who runs `kesha install --no-warmup` gets the ONNX files
(so the gate passes) and then FluidAudio downloads its bundle silently at first transcribe.
After this change the gate reports the state of the bundle that actually matters. The
no-auto-download guarantee is unchanged; the check simply stops asking about the wrong files.

*Alternative considered:* return `true` unconditionally on coreml. Rejected — it deletes the
guard rather than correcting it, and the first `kesha audio.ogg` on a fresh machine would then
pull ~473 MB with no warning at all.

### D3 — `--plan` names the external bundle instead of hiding it

`install-plan.ts` builds its ASR row from the same `ASR_FILES` list. On a CoreML target that row
is replaced by one describing FluidAudio's bundle: named, approximate size, and marked as fetched
by the Backend rather than by Kesha.

Dropping the row entirely was rejected: `--plan` exists so the cost is known before it is paid,
and ~473 MB is still a cost. Quoting 2.43 GB of ONNX is wrong; quoting nothing is also wrong.

### D4 — Diagnostics follow the Kokoro precedent

`status --disk` and `doctor` already report the FluidAudio *Kokoro* cache as an external
component. The ASR bundle gets the same treatment on coreml builds, reusing that presentation
rather than inventing a second vocabulary for "lives outside the Model cache".

## Risks / Trade-offs

- **A stale diagnostic makes a healthy install look broken** → this is the main risk and the
  reason the TS half is in scope rather than deferred. Acceptance is a real macOS install where
  `status --disk` and `doctor` both report ASR healthy with no ONNX path in sight.
- **The Rust change is invisible to PR CI.** `rust-test.yml` builds `onnx,tts` for the nextest
  run; the coreml feature set is only type-checked by the darwin clippy lane. So the gated
  branch compiles under review but is never *run* there — verification needs a local coreml
  build, the same way `kokoro_rate_e2e.rs` documents itself as a local/release-smoke gate.
- **`ensure_asr_installed` on coreml now depends on a path FluidAudio owns.** If upstream moves
  its cache, the check goes stale. Mitigated by deriving the path from one helper next to the
  existing `fluidaudio_ane_kokoro_dir`, so there is a single place to fix. The path is
  `<ApplicationSupport>/FluidAudio/Models/parakeet-tdt-0.6b-v3` — note that `Repo.folderName`
  **strips** the `-coreml` suffix, so the plausible-looking `parakeet-tdt-0.6b-v3-coreml`
  sibling is the wrong target. Keying on it would report a healthy install as broken, which is
  the exact regression this change exists to avoid.
- **Install feels slower to complete on macOS despite downloading less**, because the
  ~473 MB moves from a visible download into the warm-up step. Worth watching against #680's
  complaint; not a reason to keep downloading 2.43 GB.

## Open Questions

- Should `--no-warmup` on darwin now warn that ASR weights are not yet present? It is the one
  path that ends with an install that cannot transcribe until the next command downloads
  something. Out of scope here, but it is the honest follow-up.

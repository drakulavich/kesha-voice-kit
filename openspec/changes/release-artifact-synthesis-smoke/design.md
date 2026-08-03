## Context

`build-engine.yml` builds each platform's Engine, stages it under its release asset name,
smoke-tests it, and uploads it. The smoke step asserts `"tts"` is present in
`--capabilities-json` and, on macOS only, that `say --list-voices` surfaces a `macos-*` entry
and `en-am_michael`. Listing a voice proves the voice table compiled in; it does not run the
synthesis pipeline.

Three lanes in `ci.yml` do run a real round-trip, and none of them touches the artifact:

| Lane | Binary under test |
|---|---|
| `published-engine-smoke`, `windows-engine-smoke` | the already-published asset of the current `keshaEngine.version` |
| `release-branch-engine-smoke` (ubuntu + windows matrix) | a locally rebuilt Engine, same features, second compilation |

This is deliberate, not an oversight — a release branch cannot download a tag that does not
exist yet. But it leaves the uploaded bytes covered only by a human step in CLAUDE.md.

Two constraints shape everything below. First, `build-engine.yml` is the most
release-critical workflow in the repo and is never executed by a pull-request lane. Second,
the tag job pushes the tag *before* the build job runs, and tag names are one-use — so a
build that fails after tagging must be recoverable by re-running the run, not by cutting a
new tag.

## Goals / Non-Goals

**Goals:**

- The exact bytes that `actions/upload-artifact` uploads have synthesised English speech on
  that same runner, in that same job, before the upload step runs.
- One definition of "did it synthesise", shared with the existing round-trip lanes.
- The change itself is provable before it reaches a release.
- A static guard so a future edit cannot silently delete the gate, mirroring CLAUDE.md's
  "Never remove that step" rule for the capabilities smoke.

**Non-Goals:**

- Transcribing the synthesised audio back on the release runner (needs the multi-GB ASR set).
- Russian or any non-English voice on the linux/windows rows.
- Covering the darwin `system_kokoro` path in CI — impossible on an ANE-less runner (#678).
- Replacing or weakening the existing `--capabilities-json` assertions.
- Changing the release job, the publish path, or the CLAUDE.md draft-validation step.

## Decisions

### D1 — Drive synthesis through the CLI with `KESHA_ENGINE_BIN`, not the Engine directly

The staged artifact is reached exactly as `release-branch-engine-smoke` reaches its local
build: `KESHA_ENGINE_BIN=<staged path>`, a sibling `<path>.version` file written from
`package.json#keshaEngine.version`, and `KESHA_CACHE_DIR` scoped to the workspace.

*Alternative considered:* invoke the artifact directly (`./kesha-engine-linux-x64 say …`),
skipping Bun and the CLI entirely. Fewer moving parts inside a release-critical workflow, and
strictly narrower — the CLI's voice routing is not part of the artifact. Rejected because it
would duplicate the WAV assertions in bash and, more importantly, would not reuse
`install-kesha-backend`, whose caching is the difference between a free model restore and a
cold download on every release (D3). The CLI layer it adds is already covered by unit tests
on every PR, so a failure there is diagnosable rather than mysterious.

### D2 — Reuse `smoke-synthesis.ts` behind a synthesis-only flag

`.github/scripts/smoke-synthesis.ts` already synthesises, checks the RIFF/WAVE header, and
rejects a header-only WAV. It then transcribes the result back, which this gate cannot afford.
Add a flag (`--no-roundtrip`) that stops after the synthesis assertions, and restrict the
voice list to English when it is set.

*Alternative considered:* a second script. Rejected — two definitions of "did it synthesise"
drift, and the assertions are the part worth sharing.

### D3 — Restore models read-only from the existing `main`-scoped cache

`install-kesha-backend` is called with `cache-write: "false"` and the existing key
`${{ runner.os }}-kesha-models-tts-v1`, the same entry `published-engine-smoke` reads. No new
cache entry is minted: the repo already sits at ~9.5 GiB against GitHub's 10 GB budget
(#675), and a new key would evict something that is doing work.

Measured on the first dispatch: the linux entry restored in ~44s and the whole added block
cost ~55s (linux) / ~60s (windows), so the cache stays. macOS has no `macOS-kesha-models-tts-*`
entry, so that row downloads cold every release — a candidate for the seed workflow once #675
frees budget, not something to fix here.

### D4 — darwin synthesises through AVSpeech, not Kokoro

Two dispatch runs settled this empirically, and both corrections are worth keeping.

First, the macOS row was exempted from `kesha install` on the reasoning that an in-engine
Kokoro needs nothing on disk. Wrong: the upstream FluidAudio ANE bundle ships exactly one voice
pack, `af_heart`, and kesha works around that (#475) by staging SHA-pinned packs into
`~/.cache/fluidaudio/Models/kokoro-82m-coreml/ANE/` during `kesha install --tts`. Skipping the
install produced `invalidResponse(description: "am_michael voice pack", statusCode: 404)`.

Second — and decisive — Kokoro cannot run on the runner at all. With every asset staged, the
next run failed at `predictionFailed(stage: "vocoder", …)`: `KokoroAneModelStore` pins
`albert`, `postAlbert`, `alignment`, and `vocoder` to `.cpuAndNeuralEngine`, GitHub's
`macos-14` runner is a VM on Apple's Virtualization Framework, and the ANE is not virtualised.
Parakeet survives on the same runner because `fluidaudio-rs` sets `cfg.computeUnits = .all` for
ASR. FluidAudio documents `KokoroAneManager(computeUnits: .cpuAndGpu)` as an escape hatch, but
`fluidaudio-rs` never plumbs it — `init_kokoro(&self, default_voice, lang)` has no such
parameter — so kesha cannot reach it without an upstream change (#678).

The same binary synthesises `en-am_michael` correctly on real Apple Silicon (M2, macOS 26.5.2):
exit 0, 24 kHz mono, 3.55 s, RMS 2653. The artifact is fine; the runner is the constraint.

So the darwin row synthesises through AVSpeech instead, picking the first `macos-*` voice the
artifact lists (preferring `en-US`). That needs no models, no ANE, and no `kesha install` — and
it covers the sidecar spawn path end-to-end, which today is asserted only at list level. Kokoro
on darwin stays uncovered in CI; #678 tracks closing that, and the spec records it as a known
gap rather than an assumed pass.

### D5 — Prove the change with a build-only `workflow_dispatch`, and guard it statically

`build-engine.yml` already accepts `workflow_dispatch` with an empty `tag`, which runs the
`build` job from an arbitrary `ref`; the `release` job is gated on
`startsWith(github.ref, 'refs/tags/v')` and therefore does not run. Dispatching the workflow
against this change's branch executes the new steps on all three platforms and publishes
nothing. That is the acceptance evidence for this change — #671's premise that the workflow
"cannot be proven green by a normal PR" holds for PR lanes but not for a manual dispatch.

Separately, `check-workflows.ts` (run by the `workflow-lint` job on every PR) gains an
assertion that the synthesis step exists in `build-engine.yml` and precedes the upload step.
That is the part a *future* PR can regress, and it is cheap to hold.

## Risks / Trade-offs

- **A network flake at release time fails the build after the tag is already pushed** →
  Recover by re-running the workflow run for the same tag; a failed build does not consume the
  tag, only a new *tag name* would. Call this out in the release runbook so nobody reaches for
  a fresh tag by reflex.
- **Cache restore may not be available on a `refs/tags/v*` run** (entries are written on
  `main`) → Observed working on a branch dispatch; a tag ref is not a PR merge ref, so the same
  default-branch scope should apply. Worst case is a cold download per platform per release,
  which the build job's default 360-minute budget absorbs.
- **The gate adds failure surface to the release path** → It only fails where a release
  *should* fail; the alternative is shipping the failure. The existing assertions are left
  untouched, and the new step sits between them and the upload.
- **macOS diagnostics stay opaque under `with_silenced_stdout`** → Mitigated by the model-dir
  inventory on failure (D4), not solved. Solving it means changing production stdout handling,
  which is out of scope here.
- **Wall-clock and runner cost per release grow** → One English model set per non-Darwin
  platform, at release cadence only. #636 already judged this acceptable.

## Open Questions

- Does a workflow run triggered by `refs/tags/v*` restore a cache entry written on `main`?
  A `workflow_dispatch` run on a feature branch does — the first dispatch logged
  `Cache hit for: Linux-kesha-models-tts-v1` and restored in ~44s, with the whole added block
  costing ~55s on linux and ~60s on windows. A tag ref is not a PR merge ref, so the same
  default-branch scope should apply, but that specific case is still inference, not
  observation. macOS has no `macOS-kesha-models-tts-*` entry at all, so that row pays a cold
  download every release.
- Should the Windows row synthesise to OGG/Opus as well as WAV? #636 asks for both; the Opus
  encoder is a distinct failure surface (`opusic-sys`, vendored libopus, the cmake policy
  override). Deferred to a follow-up unless the dry run shows it is nearly free.

## Why

The Raycast extension decides whether the Engine is installed by string-matching
`"not installed"` in `kesha status` stdout (`raycast/src/lib/kesha-bin.ts:172`).
That couples a consumer to human-readable prose nobody would think twice about
rewording — and `raycast/` is mirrored into `raycast/extensions`, so a break
ships to Store users before we notice. The CLI already exposes machine-readable
output everywhere else this matters (`kesha doctor --json`, `kesha logs status
--json`, `kesha stats export --format json`); `status` is the gap.

## What Changes

- `kesha status` gains a `--json` flag that prints one JSON object to stdout and
  nothing else, replacing the human-readable rendering (same precedent as
  `kesha doctor --json`).
- The payload carries what a consumer needs to branch on: engine presence as a
  boolean, binary path, backend, protocol version, features, installed TTS voice
  ids, Bun runtime, platform, active model mirror, and the setup hint the human
  path prints to stderr.
- `--json --disk` includes the per-component disk-usage breakdown; plain `--json`
  omits it, mirroring the human flag's scope.
- The Raycast extension's `probeEngineAvailability` reads the boolean instead of
  matching prose, and keeps the current string match as a fallback so an older
  CLI on a user's machine still probes correctly.
- The `diagnostics` spec's "Open Issues" note about missing machine-readable
  status output is resolved for `status` (the `stats status` gap stays).

No breaking changes: the default human-readable output is untouched, and the new
flag is additive.

## Capabilities

### New Capabilities

None. This extends an existing command and an existing consumer.

### Modified Capabilities

- `diagnostics`: the `kesha status` requirement gains a machine-readable output
  mode — payload contract, stdout purity, and `--disk` interaction.
- `raycast-extension`: the pre-recording setup probe requirement changes from
  "match a stdout marker" to "read the structured engine-presence field, with a
  prose fallback for older CLIs".

## Impact

- `src/cli/status.ts` — new `json` arg, wired like `doctor`'s.
- `src/status.ts` — `showStatus` splits into a data collector (returns the
  payload) and the existing renderer, so both modes read one source of truth.
- `raycast/src/lib/kesha-bin.ts` — `probeEngineAvailability` switches to
  `status --json`, retaining the marker match as fallback.
- `raycast/` is mirrored into `raycast/extensions`: this needs its own PR here
  plus a follow-up upstream sync, and the payload becomes a compatibility
  surface the extension depends on across CLI versions.
- Tests: `test/` unit coverage for the payload shape and the `--disk`
  interaction; `raycast/tests/kesha-bin.test.ts` and
  `raycast/tests/dictation-controller.test.ts` for the probe matrix.
- Docs: `README` status section and `openspec/specs/diagnostics/spec.md`.

## Non-goals

- No `--json` for `kesha stats status` — a separate gap, tracked in the
  `diagnostics` spec's Open Issues.
- No `--toon` variant. That flag exists for multi-file transcription payloads
  piped into an LLM; a single status object gains nothing from it.
- No change to the human-readable output — wording, colors, and ordering stay
  exactly as they are.
- No new engine-side surface. The payload composes what the CLI already knows
  plus the existing `--capabilities-json` probe; `kesha-engine` is not touched.
- No stability guarantee beyond additive evolution — the payload carries the CLI
  version rather than a separate schema version field.
- No validation of the engine's own Capabilities JSON shape. "Readable
  capabilities" means the probe returned an object, not that dictation will
  succeed; tightening that is a separate concern.

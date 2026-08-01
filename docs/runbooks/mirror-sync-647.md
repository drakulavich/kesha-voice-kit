# Mirror sync for #647 — deferred until the CLI ships `status --json`

Prepared while #647 was in flight. **Do not open the upstream PR yet.**

## Why it waits

The extension's new probe calls `kesha status --json`. That flag does not exist
in any published CLI — 1.24.7 is current on npm, and the flag lands in #664. On
a published CLI the probe therefore falls through to the prose fallback: safe,
but the change does nothing for anyone until a CLI release carries the flag.

Order: merge #664 → release the CLI → sync the mirror.

Syncing earlier means shipping an inert feature to the Store and syncing twice.

## Preconditions

- [ ] #664 merged into `main`
- [ ] A CLI release published to npm whose `status` accepts `--json`
      (verify: `bunx @drakulavich/kesha-voice-kit@latest status --json | jq .engine.installed`)

## What moves

`raycast/` → `extensions/kesha-voice-kit/` in the fork
`drakulavich/raycast-extensions` (already exists; prior syncs were
raycast/extensions#29681 and #29758).

Files changed by #664:

- `src/lib/kesha-bin.ts` — structured probe, contract/repair hints, prose fallback anchored to the Binary line
- `src/lib/dictation-controller.ts` — `preflightMessage` maps the reason to copy
- `tests/kesha-bin.test.ts`, `tests/kesha-bin-status-json.test.ts`, `tests/dictation-controller.test.ts`
- `CHANGELOG.md` — the `{PR_MERGE_DATE}` entry is already written; Raycast substitutes the date on merge

## Before opening

- `cd extensions/kesha-voice-kit && npm ci && npm test && npm run lint`
- Confirm the CHANGELOG entry is user-facing wording, not implementation notes —
  Raycast reviewers care about this.
- Keep the diff to the files above. Every extra file enlarges the next sync.

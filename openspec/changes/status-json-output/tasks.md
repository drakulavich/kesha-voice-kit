## 1. Split collection from rendering

- [ ] 1.1 Define the status payload type in `src/status.ts` — engine presence
      boolean, binary path, backend / protocol version / features (nullable),
      voices, Bun runtime, platform + arch, model mirror, hint, optional disk
      breakdown
- [ ] 1.2 Extract `collectStatus({ disk })` from `showStatus`, returning that
      payload; move the Kokoro/Vosk enumeration, mirror resolution, and
      capabilities probe into it unchanged
- [ ] 1.3 Rewrite `showStatus` to take the payload as its only input and emit
      today's exact lines — same wording, colors, ordering, and stderr hint
- [ ] 1.4 Restructure `showDiskUsage` so the sizes are collected as data and the
      table is formatted from it; keep the recursive walk behind the `disk` flag
- [ ] 1.5 Verify byte-identical human output before/after by diffing captured
      `kesha status` and `kesha status --disk` runs

## 2. Wire the CLI flag

- [ ] 2.1 Add the `json` boolean arg to `src/cli/status.ts`, mirroring
      `src/cli/doctor.ts:16-32`
- [ ] 2.2 Serialize the payload to stdout with `console.log(JSON.stringify(...))`
      and return before any `log.*` call, so stdout carries only the object
- [ ] 2.3 Suppress the stderr setup hint under `--json` (it ships in the payload)
- [ ] 2.4 Confirm `--json --disk` includes the disk breakdown and plain `--json`
      omits it

## 3. CLI tests

- [ ] 3.1 Test: engine installed → payload reports presence `true`, path,
      backend, protocol version, features, and voice ids
- [ ] 3.2 Test: engine absent → presence `false`, hint present in the payload,
      hint absent from stderr, exit 0
- [ ] 3.3 Test: capabilities probe fails while the binary exists → presence
      `true` with backend / protocol / features null, exit 0
- [ ] 3.4 Test: stdout under `--json` parses as exactly one object and contains
      nothing else
- [ ] 3.5 Test: `--disk` presence/absence toggles the disk section
- [ ] 3.6 Test: human output still contains the `"not installed"` marker, with a
      comment naming the Raycast probe fallback as its consumer (design's
      mitigation for the load-bearing string)

## 4. Raycast probe

- [ ] 4.1 Rewrite `probeEngineAvailability` to spawn `kesha status --json`, parse
      stdout, and read the engine-presence boolean and hint
- [ ] 4.2 Keep the `stdout.includes("not installed")` match as the fallback taken
      when the parse throws or the boolean is absent
- [ ] 4.3 Preserve the existing fail-open behavior when the spawn itself fails
- [ ] 4.4 Test: structured path (engine present, engine absent)
- [ ] 4.5 Test: fallback path with human-readable stdout from an older CLI —
      both installed and not-installed cases
- [ ] 4.6 Test: unparseable/empty stdout still fails open

## 5. Docs and specs

- [ ] 5.1 Document `--json` in the README status section
- [ ] 5.2 Run `/opsx:sync` to fold both delta specs into
      `openspec/specs/diagnostics/spec.md` and
      `openspec/specs/raycast-extension/spec.md`
- [ ] 5.3 Carry the new Open Issues (no schema version field; prose marker still
      load-bearing; `doctor`/`status` payload overlap unenforced) into the synced
      specs

## 6. Verification

- [ ] 6.1 `bun test && bunx tsc --noEmit`
- [ ] 6.2 Run the Raycast extension's own test suite under `raycast/`
- [ ] 6.3 Manual check against a real install: `kesha status --json | jq .` with
      the engine present, and with `KESHA_ENGINE_BIN` pointed at a missing path
- [ ] 6.4 Open the PR with `Closes #647` in the body; note in the description
      that the `raycast/extensions` mirror sync is a required follow-up

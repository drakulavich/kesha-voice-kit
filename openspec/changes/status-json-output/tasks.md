## 1. Split collection from rendering

- [x] 1.1 Define the status payload type in `src/status.ts` to match the
      normative example in design.md exactly — nested `engine.capabilities`
      (one null, not three), every key always present, `voices: []` when empty,
      `cliVersion`, `disk: null` without `--disk`
- [x] 1.2 Extract `collectStatus({ disk })` from `showStatus`, returning that
      payload; move the Kokoro/Vosk enumeration, mirror resolution, and
      capabilities probe into it unchanged
- [x] 1.3 Rewrite `showStatus` to take the payload as its only input and emit
      today's exact lines — same wording, colors, ordering, and stderr hint
- [x] 1.4 Restructure `showDiskUsage` so the sizes are collected as data and the
      table is formatted from it; keep the recursive walk behind the `disk` flag
- [x] 1.5 Verify the human output still carries the same information before/after;
      assert the `"not installed"` marker on the Binary line rather than diffing
      bytes, which colors and TTY detection make brittle

## 2. Wire the CLI flag

- [x] 2.1 Add the `json` boolean arg to `src/cli/status.ts`, mirroring
      `src/cli/doctor.ts:16-32`
- [x] 2.2 Serialize with `JSON.stringify(payload, null, 2)` (matching `doctor`
      and `logs`) and return before any `log.*` call — `log.info` writes to
      stdout (`src/log.ts:46`), so a stray call corrupts the payload
- [x] 2.3 Suppress the stderr setup hint under `--json` (it ships in the payload)
- [x] 2.4 Confirm `--json --disk` includes the disk breakdown and plain `--json`
      omits it

## 3. CLI tests

- [x] 3.1 Test: engine installed → payload reports presence `true`, path,
      backend, protocol version, features, and voice ids
- [x] 3.2 Test: engine absent → presence `false`, hint present in the payload,
      hint absent from stderr, exit 0
- [x] 3.3 Test: capabilities probe fails while the binary exists → presence
      `true` with backend / protocol / features null, exit 0
- [x] 3.4 Test: stdout under `--json` parses as exactly one object and contains
      no other bytes
- [x] 3.5 Test: `--json --disk` with no engine reports the disk breakdown as null
      without walking the cache
- [x] 3.6 Test: `--disk` presence/absence toggles the disk section
- [x] 3.7 Test: human output still contains the `"not installed"` marker, with a
      comment naming the Raycast probe fallback as its consumer (design's
      mitigation for the load-bearing string)

## 4. Raycast probe

- [x] 4.1 Rewrite `probeEngineAvailability` to spawn `kesha status --json`, parse
      stdout, and read the engine-presence boolean and hint
- [x] 4.2 Keep the `stdout.includes("not installed")` match as the fallback, taken
      when stdout is not JSON at all — not when it parses but breaks the contract
      (see 4.5)
- [x] 4.3 Preserve the existing fail-open behavior when the spawn itself fails
- [x] 4.4 Treat present-with-null-capabilities as unavailable, with finish-setup
      wording distinct from the never-installed case; establish what the repair
      command actually is first (see the spec's Open Issue — `install` has no
      documented force flag)
- [x] 4.5 Take the prose fallback only for non-JSON stdout; JSON whose `installed`
      is not a boolean is a contract error → unavailable, never prose
- [x] 4.6 Anchor the prose match to the Binary line instead of whole-stdout
- [x] 4.7 Vary the finish-setup message, not just the hint, in
      `raycast/src/lib/dictation-controller.ts:90` — it currently hardcodes one
      message for every preflight failure
- [x] 4.8 Cover the full probe matrix with tests, one case per row of the table in
      design.md: contract JSON installed / not installed / caps-null; non-JSON
      with and without the marker; JSON with a wrong shape; empty and garbage
      stdout; spawn throw with and without an install hint on stderr
- [x] 4.9 Tests live in `raycast/tests/kesha-bin.test.ts` and
      `raycast/tests/dictation-controller.test.ts`

## 5. Docs and specs

- [x] 5.1 Document `--json` in the README status section
- [x] 5.2 Run `/opsx:sync` to fold both delta specs into
      `openspec/specs/diagnostics/spec.md` and
      `openspec/specs/raycast-extension/spec.md`
- [x] 5.3 Carry the new Open Issues into the synced specs: prose marker still
      load-bearing; `doctor`/`status` payload overlap unenforced; repair command
      unverified; controller message hardcoded; capabilities readable ≠ dictation
      will succeed

## 6. Verification

- [x] 6.1 `bun test && bunx tsc --noEmit`
- [x] 6.2 Run the Raycast extension's own test suite under `raycast/`
- [~] 6.3 Manual check: the missing-engine path was exercised end-to-end
      (`--json`, `--json --disk`, exit 0, empty stderr). The engine-present path
      was NOT run against a real install — no engine on this machine — and is
      covered only by unit tests driving a fake `--capabilities-json` binary.
      Worth one real run before the mirror sync.
- [x] 6.4 Open the PR with `Closes #647` in the body; note in the description
      that the `raycast/extensions` mirror sync is a required follow-up

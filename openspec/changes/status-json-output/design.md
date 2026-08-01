## Context

`showStatus` (`src/status.ts:59`) both gathers state and renders it, interleaving
`log.info` calls with the lookups that feed them. There is no value to serialize —
the data only ever exists as formatted lines. Adding `--json` therefore means
splitting collection from rendering, not bolting a second printer onto the first.

The consumer that motivates this, `probeEngineAvailability`
(`raycast/src/lib/kesha-bin.ts:166`), spawns whatever `kesha` it resolves on the
user's machine. The extension ships through the Raycast Store on its own cadence,
so extension version and CLI version are independent: a new extension will meet
old CLIs, and the probe must keep working on both.

Verified while writing this design (worktree, engine absent):

```
$ bun bin/kesha.js status --json ; echo $?
0
# stdout: human-readable status; stderr: "Run `kesha install` to download …"
```

citty ignores an unknown flag — no error, exit 0, unchanged output. That is the
property the compatibility story rests on, and it is now a measured fact rather
than an assumption.

## Goals / Non-Goals

**Goals:**

- One collector feeding both renderings, so human and JSON output cannot drift.
- A payload a consumer can branch on with a boolean, never a substring.
- A probe that works against both new and old CLIs without version sniffing.
- Stdout under `--json` parses as exactly one JSON object.

**Non-Goals:**

- Unifying with `doctor --json`'s report type. They overlap, but `doctor` is a
  redaction-aware diagnostic dump and `status` is a fast install check; merging
  them would drag redaction semantics into a hot path the extension calls before
  every Dictation session.
- A schema version field in the payload (see Decisions).
- Changing the engine. Everything here composes data the CLI already has.

## Decisions

**Split `showStatus` into `collectStatus()` + `renderStatus()`.** The alternative —
a parallel `showStatusJson()` — was rejected because it duplicates the Kokoro/Vosk
enumeration and mirror-resolution logic, which is exactly the kind of duplication
that lets the two modes disagree silently. `collectStatus()` returns the payload;
the human path formats it; `--json` serializes it. `--disk` sets a flag on the
collector so the disk breakdown is computed only when asked (it walks the cache
recursively and is not free).

**Probe strategy: try structured, fall back to prose.** `probeEngineAvailability`
runs `kesha status --json`, attempts `JSON.parse` on stdout, and:

- parses and the payload has the engine-presence boolean → use it;
- parse throws, or the boolean is absent → fall back to the existing
  `stdout.includes("not installed")` match;
- spawn fails outright → fail open, unchanged from today.

The parse failure *is* the version detection. Alternatives considered: probing
`kesha --version` and comparing semver (an extra spawn before every session, plus
a version table to maintain), or a `--capabilities`-style CLI self-description
(more surface than this problem justifies). Both lose to letting the old CLI's own
output be the signal.

**Hint moves into the payload; stderr stays quiet under `--json`.** The human path
writes the setup hint via `log.warn` to stderr, and the probe currently harvests
stderr for it. Under `--json` the hint is a payload field and is not duplicated on
stderr, so stdout+payload is self-contained. The prose fallback path still reads
stderr, because that is what an old CLI produces.

**Presence and usability are two different questions.** The boolean answers "is
there a binary", not "can it run" — an Engine that exists but cannot report its
capabilities is present and unusable at the same time. The probe therefore
requires presence AND non-null capabilities before starting a Dictation session,
rather than branching on the boolean alone. Collapsing both into a single
`usable` boolean was rejected: the extension needs the two apart to word the
finish-setup view correctly, since repairing a broken install is a different
instruction from performing a first one. Note the prose fallback cannot make this
distinction at all — an older CLI's "probe failed" line is not what the marker
match reads — so the guarantee holds on the structured path only. That is today's
behaviour too, so it is a gap being narrowed rather than a regression.

**Capabilities failure reports nulls, not omissions.** `getEngineCapabilities()`
(`src/engine.ts:348`) already collapses "binary missing", "non-zero exit", and
"unparseable JSON" into a single `null`. The payload mirrors that: engine present
`true`, backend/protocol/features `null`. A consumer distinguishing "no engine"
from "broken engine" reads the boolean and the nulls separately. Adding a
`capabilitiesProbeFailed` boolean was rejected as redundant with the nulls.

**No schema version field.** The CLI is versioned and consumers already know which
CLI they spawned; a second version number would need its own bump discipline to
stay honest, and nothing enforces that. Growth is additive-only by convention, and
the risk this leaves is recorded in the spec's Open Issues rather than papered
over.

## Risks / Trade-offs

- **The prose marker stays load-bearing indefinitely** → the fallback keeps
  `"not installed"` meaningful for as long as old CLIs exist, which is the exact
  coupling this change set out to remove — just narrowed to a fallback path.
  Mitigation: a CLI-side test asserts the marker's presence in human output with a
  comment naming the extension as its consumer, so a reword fails locally instead
  of in the Store. Full removal needs a deprecation call nobody can make yet.
- **Two renderings of one payload can still drift in *content*** (a field added to
  the payload but never shown to Maks) → mitigation: the human renderer takes the
  payload as its only input, so a new field is visibly unused rather than
  invisibly missing.
- **`--json --disk` invites a slow path into a script** → the disk walk is
  recursive over the model cache. It stays opt-in behind `--disk`, exactly as
  today; plain `--json` does not touch it.
- **The mirrored `raycast/extensions` copy drifts** → this lands as its own PR
  here and a follow-up upstream sync, per the existing mirror discipline. Until
  the sync lands, Store users are on the fallback path — which is why the fallback
  is not optional.

## Migration Plan

Additive; no migration. The flag is new, the default output is byte-identical, and
the extension change is backward compatible in both directions (new extension +
old CLI works via fallback; old extension + new CLI works because human output is
unchanged). Rollback is reverting the PR — no persisted state, no format anyone
has stored.

## Open Questions

- Should `kesha stats status --json` follow in the same PR? The `diagnostics` spec
  lists it as a sibling gap. Kept out of scope here to keep the change reviewable,
  but if the collector split lands cleanly the same shape applies.
- Is there a second consumer for this payload (MCP server, OpenClaw plugin) that
  would change what belongs in it? Neither reads `status` today, so the payload is
  designed for the extension's needs plus obvious diagnostics.

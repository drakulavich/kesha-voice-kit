# Design — Engine version override

## Context

`downloadEngine` reads the Pinned Engine version once and uses it for three things: the
release URL, the cache-validity comparison against the `.version` file beside the binary,
and — indirectly — what `kesha doctor` considers correct.

```
src/engine-install.ts:564-580
  binPath          = getEngineBinPath()            // KESHA_ENGINE_BIN or default
  installedVersion = readInstalledEngineVersion(binPath)
  versionMatches   = exists(binPath) && installedVersion === engineVersion
  cacheValid       = versionMatches && (!noCache || !canWriteEngineDir)
  cacheValid ? refreshCachedEngine(...) : fetchEngineBinary(binPath, installedVersion)
```

Two consequences shape this design. First, the pin is the *only* input for the Engine
download — no path in `src/`, the workflows or `flake.nix` resolves a floating release.
(The Homebrew formula installs the CLI from a tag tarball and never fetches an Engine, so
it is not evidence either way; the "latest" link in `docs/linux-packages.md` is for human
readers.) Second, a binary whose `.version` disagrees with the pin is treated as a stale
cache and replaced, which is why placing an alpha at `KESHA_ENGINE_BIN` and running an
install destroys it.

The change is small in code and load-bearing in policy. It is the sanctioned alternative to
editing the pin — **once #736 lands**, which forbids an alpha there. #736 is open at the
time of writing, so this change depends on it rather than following from it. The gap it
fills exists either way: there is no way today to install a named Engine version without
editing `package.json`.

## Goals / Non-Goals

**Goals:**

- Install a named Engine version without editing `package.json`.
- Keep the pin the default and the only version any unattended path resolves.
- Make the resulting divergence visible rather than something to rediscover while
  debugging.
- Fail loudly when the named version has no release.

**Non-Goals:**

- Resolving "the newest alpha", or any floating version.
- Persisting the override beyond the invocation that names it.
- Changing what a published CLI downloads for end users.

## Decisions

### A flag on `kesha install`, not an environment variable

`--engine-version <version>` is typed per install. An env var would apply to every command
in the shell for as long as it is exported, and the repository already has one variable
with exactly that failure mode: `KESHA_ENGINE_BIN` silently redirects the Engine path, and
the CI lanes that use it must also write a matching `.version` to stop installs clobbering
it. Adding a second ambient switch would compound that.

*Alternative considered:* `KESHA_ENGINE_VERSION`, which composes better with existing CI
patterns and needs no CLI surface. Rejected because "set once, forgotten, wrong Engine for
weeks" is the failure this whole area keeps producing, and because a flag is visible in the
shell history that produced the install.

### The requested version flows through, rather than being read at the bottom

`downloadEngine` takes the version it should install as a parameter, defaulting to the pin.
Everything downstream uses that one value: the binary URL (`:439`), the cache comparison
(`:572`), the `.version` write (`:473`), **and the Sidecar downloads** — `fetchEngineBinary`
starts them at `:445` and `refreshCachedEngine` tops up missing ones at `:358`, both from
the module-level pin today. `src/engine-install.ts` reads that import at fifteen sites; a
half-threaded change leaves darwin-arm64 with an overridden Engine and pinned Sidecars, or
installs the alpha and then replaces it on the next cache check.

`src/install-plan.ts` is the same shape: the pin is read at `:188`, `:191`, `:211` and
`:336`, and `buildInstallCommand` (`:405`) prints the reproducible command. Changing only
the header leaves four of five wrong, including a `Run:` line that reproduces something
else.

### A missing release is an error, never a fallback to the pin

`fetchEngineBinary` already surfaces the HTTP status. The override adds the version to the
message so the failure names the tag it looked for. Silently installing the pinned Engine
after an explicit `--engine-version` would produce exactly the false-green this change
exists to prevent — the caller believes they are testing an alpha and are not.

### Drift is a `doctor` state, not a warning on every command

Printing a warning from every invocation would pollute stderr for the whole time an
override is in use, and `kesha say` sends audio to stdout with all progress on stderr.
`kesha doctor` is where installation truth is already reported, so drift is named there.

`doctor` already prints `Version marker:` (`doctor.ts:456`); what is missing is the pin
beside it and any statement that the two disagree. A marker alone reads as health, which is
the actual defect.

*Alternative considered:* refusing to run any command while the installed Engine differs
from the pin. Rejected — that is the entire supported use of the flag.

### The override does not relax rule 3

#736's rule 3 rejects an alpha in `package.json#keshaEngine.version`. This change gives
that rule a real alternative rather than an exception: the alpha is installed by naming it,
and the committed pin stays stable. Nothing in this design writes to `package.json`.

## Risks / Trade-offs

- **A developer forgets an override is installed and debugs a ghost.** → `kesha doctor`
  names the drift explicitly, and the `.version` file records what is actually on disk.
- **The flag becomes a de-facto channel** ("just install the alpha" in a README). →
  Non-goals state it is per-invocation and exact-version-only; documentation should point
  at the `alpha` npm dist-tag for the CLI and at this flag only for trying an Engine.
- **CI adopts the flag and silently drifts from the pin.** → CI lanes assert the pin
  (`check-engine-targets.ts`); a lane using the override should say so at the call site.
- **An override version that is older than the installed binary.** No downgrade protection
  is proposed: naming an exact older version is a legitimate bisection move.
- **A release is validated against an Engine the pin does not name.** `doctor` reports the
  drift, but nothing refuses. `make smoke-test` and the release preflight run against the
  default Engine path and would happily exercise an override. → This change is scoped as a
  developer tool for trying an Engine, not as a release-safety gate; whether preflight
  should refuse on drift is left open below rather than assumed.
- **Any install without the flag silently reverts to the pin**, including additive ones like
  `kesha install --tts en`. That follows from "not a second pin" and is intended, but it is
  the most likely surprise: the fix is to repeat the flag, not to make the override sticky.

## Resolved while implementing

- **`kesha init` does not accept the flag.** Init is the guided first-run path; an override
  is an expert action, and adding it there would put a "which engine build?" question in
  front of someone installing for the first time. `kesha init --plan` still names the pin.
- **The programmatic `downloadModel` API does not take the option.** The version-carrying
  entry point is `installEngine` in `src/engine-install.ts`, which the CLI calls;
  `downloadEngine` (exported as `downloadModel`) keeps its signature and always installs the
  pin. It forwards field by field rather than spreading, so a caller's stray `version` cannot
  reach the installer through the untyped path.
- **No major-version guard.** Naming a distant version is already an explicit act, and the
  useful check is behavioural — the Engine reports its protocol version through Capabilities
  JSON, which surfaces on use. A numeric guard would additionally block the legitimate
  bisection case. Nothing here forecloses adding the behavioural check later.

## Open Questions
- Should the release preflight refuse to run against a drifted Engine? Reporting it in
  `doctor` is enough for a developer trying a build; it is not enough to stop a release from
  being smoke-tested against an Engine the pin does not name.

Answered while writing the spec, recorded so it is not reopened: `--plan` must state the
overridden version *and* carry the flag into the command it prints — a preview that
reproduces something other than what it previewed is worse than no preview.

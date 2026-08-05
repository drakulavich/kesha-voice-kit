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

Two consequences shape this design. First, the pin is the *only* input — there is no
floating resolution anywhere in the repository (verified across `src/`, workflows,
`flake.nix`, the Homebrew formula and the model URLs). Second, a binary whose `.version`
disagrees with the pin is treated as a stale cache and replaced, which is why placing an
alpha at `KESHA_ENGINE_BIN` and running an install destroys it.

The change is small in code and load-bearing in policy: it is the sanctioned alternative
to editing the pin, which #736 forbids for alphas.

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
The cache comparison and the `.version` write both use the requested version, so the three
uses stay consistent by construction. Reading the pin in one place and the override in
another is how "install says 1.24.8-alpha.1, cache check says 1.24.7, re-download" bugs get
written.

### A missing release is an error, never a fallback to the pin

`fetchEngineBinary` already surfaces the HTTP status. The override adds the version to the
message so the failure names the tag it looked for. Silently installing the pinned Engine
after an explicit `--engine-version` would produce exactly the false-green this change
exists to prevent — the caller believes they are testing an alpha and are not.

### Drift is a `doctor` state, not a warning on every command

Printing a warning from every invocation would pollute stderr for the whole time an
override is in use, and `kesha say` sends audio to stdout with all progress on stderr.
`kesha doctor` is where installation truth is already reported, so drift is named there.

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

## Open Questions

- Should `kesha init` accept the flag, or is `kesha install` the only entry point? Init is
  the guided path and an override is an expert action, which argues for leaving it out.
- Should the programmatic `downloadModel` API (`src/lib.ts`) take the same option? Sona's
  use cases do not obviously need it, and adding it widens a stable public surface.
- Should `--engine-version` reject a version whose major differs from the pin, on the
  grounds that the CLI cannot speak an arbitrarily distant Engine's Capabilities JSON? The
  Engine already reports a protocol version, so the check could be behavioural rather than
  numeric.
- Does `--plan` need to show the overridden version? It shows the download plan and would
  otherwise state the pin, which would be wrong.

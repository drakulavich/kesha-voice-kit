# Engine version override

## Why

`package.json#keshaEngine.version` is the only thing that decides which Engine the CLI
downloads — `src/engine-install.ts:439` builds the binary URL from it, `:445` and `:358`
pass it to the Sidecar downloads, and nothing resolves a floating "latest". That makes the
pin a switch rather than a hint:
whatever it says is what every developer machine, every CI lane on every unrelated pull
request, and every published CLI will fetch.

#736 turns that observation into a rule: the pin may never name an alpha, because
committing a throwaway build points all of the above at it. That PR is still open, so this
change depends on it rather than following from it — but the gap stands on its own: the
alpha Engine channel (#685 group 7) exists precisely so a change can be *tried* before it
is committed, and there is no way today to install a specific Engine version without
editing the pin.

`KESHA_ENGINE_BIN` does not fill the gap. It overrides only the path
(`src/engine.ts::getEngineBinPath`); `downloadEngine` still derives its URL from the pin,
and when the `.version` file beside the binary disagrees it re-downloads the pinned Engine
**over** the binary the user placed there (`src/engine-install.ts:571-580`). CI works
around this by writing a `.version` that matches the pin so the cache check passes and no
fetch happens (`ci.yml` ~641, `build-engine.yml` ~303) — a workaround, not an interface.

## What Changes

- `kesha install` accepts `--engine-version <version>`, downloading that Engine release
  instead of the pinned one. The version is recorded next to the binary, so later commands
  and `kesha doctor` can tell which Engine is actually installed.
- `kesha doctor` names an installed Engine that differs from the pin, showing both
  versions. It already prints the recorded marker (`doctor.ts:456`) — what is missing is the
  pin beside it and any statement that the two disagree, so drift currently reads as health.
- A version that has no published release fails with an actionable error naming the tag it
  looked for — never a silent fallback to the pin.
- No behaviour changes when the flag is absent: the pin remains the default and the only
  version any unattended path resolves.

## Capabilities

### New Capabilities

None. This extends an existing install path rather than introducing a capability.

### Modified Capabilities

- `installation`: a new requirement for the explicit version override, and its
  relationship to the Pinned Engine version.
- `diagnostics`: `kesha doctor` gains a named state for "installed Engine does not match the
  pin", which today is unnamed — the marker is shown, the pin never is.

## Non-goals

- **Not an auto-update or channel subscription.** There is no "install the newest alpha";
  the caller names an exact version each time. Nothing resolves a floating release, and
  this change must not create the first such path.
- **Not a second pin.** The override is per-invocation. It is deliberately not an
  environment variable that survives a shell session, so an Engine cannot be swapped for
  every future command by something set once and forgotten.
- **Not a relaxation of "never auto-download".** The override only changes *which* version
  an explicit `kesha install` fetches; no command gains the ability to download on its own.
- **Not a way to reintroduce alpha pins.** #736's rule 3 stays; this is the sanctioned
  alternative to editing the pin, not an escape from the gate.
- **Not Engine-alpha publishing.** Producing the alpha releases is #685 group 7; this
  change only makes one installable once it exists.
- **Not a release-safety gate.** `doctor` names the drift; nothing refuses to run. Whether
  the release preflight should refuse to smoke-test against a drifted Engine is left open in
  the design rather than assumed here.

## Impact

- `src/cli/install.ts` — flag parsing, validation, and the install summary.
- `src/engine-install.ts` — `downloadEngine` takes the requested version rather than
  reading the pin unconditionally; the cache-validity comparison and the `.version` write
  follow it.
- `src/doctor.ts` — names pin-vs-installed drift.
- `src/install-plan.ts` — the plan reads the pin at four sites and prints a reproducible
  command that carries no version flag; all five must follow the override.
- `openspec/specs/GLOSSARY.md` — *Pinned Engine version* and *Recorded Engine version* as
  canonical terms, since the two are what every requirement here distinguishes.
- `openspec/specs/installation`, `openspec/specs/diagnostics` — requirement deltas.
- #685 task 7.3, whose stated verification ("set the pin to the alpha and run
  `kesha install`") becomes achievable without violating #736.

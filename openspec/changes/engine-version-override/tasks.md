## 1. Thread the requested version through the install path

- [ ] 1.1 Give `downloadEngine` an explicit "version to install" input, defaulting to `package.json#keshaEngine.version`, so the pin is read in one place rather than at the bottom of the call
- [ ] 1.2 Make every consumer use that one input: the binary URL (`:439`), the cache comparison (`:572`), the recorded-version write (`:473`), and the Sidecar downloads in both `fetchEngineBinary` (`:445`) and `refreshCachedEngine` (`:358`) — a mismatch between any two is the "installs the alpha, then replaces it" bug, and missing the Sidecars leaves darwin-arm64 half-overridden
- [ ] 1.3 Confirm an override installs *to* the path `KESHA_ENGINE_BIN` resolves, replacing what is there — they compose rather than conflict, and "no interaction" would be the wrong acceptance criterion
- [ ] 1.4 Fail with an actionable error when the Engine directory is read-only and the requested version differs, rather than reporting success against the binary already present

## 2. Expose it on `kesha install`

- [ ] 2.1 Add `--engine-version <version>` and reject a value that is not valid SemVer, before any network call
- [ ] 2.2 Fail with an error naming the tag that was looked for when the release does not exist, and confirm no fallback to the pin happens on any path
- [ ] 2.3 State the version being installed in the install summary, so an override is visible in the output it produces
- [ ] 2.4 Decide and record whether `kesha init` accepts the flag (design Open Question); if not, confirm init still installs the pin

## 3. Make the divergence visible

- [ ] 3.1 Report installed-vs-pinned drift in `kesha doctor` as a named state, showing both versions, without reporting the Engine as broken
- [ ] 3.2 Make `--plan` state the version the real install would fetch and judge cached-versus-needed against it — the pin is read at `install-plan.ts:188`, `:191`, `:211`, `:336`
- [ ] 3.3 Carry the flag into `buildInstallCommand` (`:405`), so the `Run:` line reproduces the install that was previewed rather than a different one

## 4. Tests

- [ ] 4.1 Unit: the requested version reaches the URL, the cache comparison and the recorded version — assert all three from one override, since testing only the URL would miss the clobber
- [ ] 4.2 Unit: an unreleased version fails and leaves any existing binary untouched
- [ ] 4.3 Unit: no override leaves current behaviour byte-identical, including the recorded version
- [ ] 4.4 Unit: `doctor` names both versions on drift and stays silent without it
- [ ] 4.5 CLI contract: `--plan --engine-version` names the overridden version, prints a `Run:` line carrying the flag, and downloads nothing
- [ ] 4.6 Unit: an additive install without the flag (`--tts en`) reverts to the pin, pinning the intended behaviour so nobody "fixes" it into a sticky override

## 5. Close the loop with the alpha channel

- [ ] 5.1 Rewrite #685 task 7.3 to verify an Engine alpha through this flag instead of by committing an alpha pin, which rule 3 rejects
- [ ] 5.2 Verify end to end against a published Engine alpha once #685 group 7 exists: install it by name, run a transcription, then reinstall without the flag and confirm the pinned Engine returns
- [ ] 5.3 Confirm `check:versions` still rejects an alpha pin afterwards — the override must be an alternative to editing the pin, never an argument for allowing it

## 6. Documentation

- [ ] 6.1 Document the flag where installation is documented, framed as an expert action for trying an Engine, not as a channel
- [ ] 6.2 Say that any later install without the flag returns to the pin, and show the one-shot form (`--engine-version X --tts en`) — this is the most likely surprise
- [ ] 6.3 State that the CLI's own prerelease channel is the `alpha` npm dist-tag, so the two are not confused
- [ ] 6.4 Confirm no first-time install hint mentions the flag, and that any install text added here says bun, never npm

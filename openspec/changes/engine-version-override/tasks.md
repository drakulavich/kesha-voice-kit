## 1. Thread the requested version through the install path

- [ ] 1.1 Give `downloadEngine` an explicit "version to install" input, defaulting to `package.json#keshaEngine.version`, so the pin is read in one place rather than at the bottom of the call
- [ ] 1.2 Make the release URL, the cache-validity comparison against the recorded version, and the recorded-version write all use that one input (`src/engine-install.ts:564-580`) — a mismatch between any two is the "installs the alpha, then replaces it" bug
- [ ] 1.3 Confirm `KESHA_ENGINE_BIN` still only redirects the path, and that an override plus a custom path do not interact

## 2. Expose it on `kesha install`

- [ ] 2.1 Add `--engine-version <version>` and reject a value that is not valid SemVer, before any network call
- [ ] 2.2 Fail with an error naming the tag that was looked for when the release does not exist, and confirm no fallback to the pin happens on any path
- [ ] 2.3 State the version being installed in the install summary, so an override is visible in the output it produces
- [ ] 2.4 Decide and record whether `kesha init` accepts the flag (design Open Question); if not, confirm init still installs the pin

## 3. Make the divergence visible

- [ ] 3.1 Report installed-vs-pinned drift in `kesha doctor` as a named state, showing both versions, without reporting the Engine as broken
- [ ] 3.2 Make `--plan` state the version the real install would fetch, including under an override, and check the reproducible command it prints carries the flag

## 4. Tests

- [ ] 4.1 Unit: the requested version reaches the URL, the cache comparison and the recorded version — assert all three from one override, since testing only the URL would miss the clobber
- [ ] 4.2 Unit: an unreleased version fails and leaves any existing binary untouched
- [ ] 4.3 Unit: no override leaves current behaviour byte-identical, including the recorded version
- [ ] 4.4 Unit: `doctor` names both versions on drift and stays silent without it
- [ ] 4.5 CLI contract: `--plan --engine-version` names the overridden version and downloads nothing

## 5. Close the loop with the alpha channel

- [ ] 5.1 Rewrite #685 task 7.3 to verify an Engine alpha through this flag instead of by committing an alpha pin, which rule 3 rejects
- [ ] 5.2 Verify end to end against a published Engine alpha once #685 group 7 exists: install it by name, run a transcription, then reinstall without the flag and confirm the pinned Engine returns
- [ ] 5.3 Confirm `check:versions` still rejects an alpha pin afterwards — the override must be an alternative to editing the pin, never an argument for allowing it

## 6. Documentation

- [ ] 6.1 Document the flag where installation is documented, framed as an expert action for trying an Engine, not as a channel
- [ ] 6.2 State that the CLI's own prerelease channel is the `alpha` npm dist-tag, so the two are not confused
- [ ] 6.3 Confirm no first-time install hint mentions the flag, and that any install text added here says bun, never npm

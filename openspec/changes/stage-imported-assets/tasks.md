## 1. Guard first

- [ ] 1.1 Rewrite `tests/unit/distribution-assets.test.ts` to derive the asset set from the root imports in `src/` and `bin/` (D1); run it on unchanged payloads and see it fail for `model-plan.json` on the formula, `Dockerfile` and `flake.nix`

## 2. Stage the asset

- [ ] 2.1 Add `model-plan.json` to `libexec.install` in `packaging/homebrew/Formula/kesha-voice-kit.rb`
- [ ] 2.2 Add `COPY model-plan.json ./` to `Dockerfile`
- [ ] 2.3 Add `./model-plan.json` to the `flake.nix` fileset and to its `cp -r` line
- [ ] 2.4 Add `assert_match "Kesha install plan", shell_output("#{bin}/kesha install --plan")` to the formula's `test do` (D2)

## 3. Publish the whole formula

- [ ] 3.1 `update-homebrew-tap.mjs` reads the in-repo formula, rewrites its pins and writes it over the tap file (D3)
- [ ] 3.2 `tests/unit/update-homebrew-tap.test.ts`: given a tap formula with a `parakeet` block, the output equals the in-repo formula with pins rewritten

## 4. Land

- [ ] 4.1 Update the `cli-distribution` Open Issues: drop "`model-plan.json` is unaffected", and close out the template/tap drift note
- [ ] 4.2 PR with `Closes #1429`; release notes for the next stable release mention that `parakeet` leaves Homebrew

## Definition of Done

- [ ] `bun test tests/unit/distribution-assets.test.ts tests/unit/update-homebrew-tap.test.ts` passes
- [ ] `just mutate packaging/homebrew/Formula/kesha-voice-kit.rb '"model-plan.json", ' '' bun test tests/unit/distribution-assets.test.ts` reports the mutation caught; the same for `Dockerfile` (`COPY model-plan.json ./`) and `flake.nix` (`./model-plan.json`)
- [ ] `grep -c model-plan.json packaging/homebrew/Formula/kesha-voice-kit.rb Dockerfile flake.nix` prints at least 1 for each file
- [ ] The `homebrew-formula` CI lane is green on the PR head, with `kesha install --plan` in its `brew test` log
- [ ] The scheduled CI run on `main` after the merge has `homebrew-formula` green
- [ ] `bun run check` and `openspec validate stage-imported-assets --strict` pass

# Homebrew Install

Kesha's Homebrew formula installs the Bun-based CLI wrapper. It does not
download the Rust engine or models during `brew install`; keep that explicit
with `kesha install`.

## Install

```bash
brew tap oven-sh/bun
brew install drakulavich/tap/kesha-voice-kit
kesha install
kesha audio.ogg
```

The formula depends on Bun from the official Bun tap and exposes the `kesha`
command.

## Package Scope

Homebrew installs:

- the TypeScript CLI wrapper
- production Bun dependencies
- the `kesha` command

`kesha install` still downloads release assets into the Kesha cache. This keeps
the package install lightweight and preserves the no-surprise-downloads release
contract used by the Bun and Docker install paths.

## Maintainer Validation

The source formula remains in this repository and is mirrored into
`drakulavich/homebrew-tap` for users. Its committed `url`/`sha256` name the real
release tarball. CI's `homebrew-formula` lane does **not** trust that pin: it
stages a throwaway tap copy whose `url` is a `git archive` of HEAD, so the
install block is exercised against the checkout under review rather than a
released tree (#924). To validate formula edits against HEAD locally the same
way CI does:

```bash
brew tap oven-sh/bun
brew tap-new local/tap
node .github/scripts/stage-homebrew-worktree-formula.mjs \
  --tap-dir "$(brew --repository local/tap)" \
  --archive "$(mktemp -d)/kesha-worktree.tar.gz"
brew install --build-from-source local/tap/kesha-voice-kit
brew test local/tap/kesha-voice-kit
brew audit --strict --formula "$(brew --repository local/tap)/Formula/kesha-voice-kit.rb"
```

The public tap itself can be validated with:

```bash
brew install drakulavich/tap/kesha-voice-kit
brew test drakulavich/tap/kesha-voice-kit
brew audit --strict --formula drakulavich/tap/kesha-voice-kit
```

Stable `vX.Y.Z` releases update the public tap through the `Homebrew Tap`
workflow. The workflow requires the `HOMEBREW_TAP_TOKEN` repository secret with
write access to `drakulavich/homebrew-tap`.

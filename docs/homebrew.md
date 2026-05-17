# Homebrew Formula

Kesha's Homebrew formula installs the Bun-based CLI wrapper. It does not
download the Rust engine or models during `brew install`; keep that explicit
with `kesha install`.

## Local Tap Validation

The first Homebrew slice keeps the formula in this repository while the public
tap automation is still future work. Homebrew requires formulae to be installed
from a tap, so validate the formula through a local test tap:

```bash
brew tap oven-sh/bun
brew tap-new local/kesha
cp Formula/kesha-voice-kit.rb "$(brew --repository local/kesha)/Formula/"
brew install local/kesha/kesha-voice-kit
kesha install
kesha audio.ogg
```

The formula depends on Bun from the official Bun tap and exposes both `kesha`
and the backward-compatible `parakeet` alias.

## Package Scope

Homebrew installs:

- the TypeScript CLI wrapper
- production Bun dependencies
- the `kesha` and `parakeet` commands

`kesha install` still downloads release assets into the Kesha cache. This keeps
the package install lightweight and preserves the no-surprise-downloads release
contract used by the Bun and Docker install paths.

## Future Public Tap

The intended user-facing path is a dedicated tap, for example:

```bash
brew install drakulavich/kesha/kesha-voice-kit
```

Until that tap exists, use the local tap validation path above.

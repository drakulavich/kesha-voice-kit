# OpenClaw Plugin Specification

## Purpose

The OpenClaw plugin gives an LLM agent ears: a voice message arriving in any
channel OpenClaw is connected to gets transcribed locally by Kesha before the
agent reads it. The plugin ships inside the CLI package. It is a thin adapter —
it declares an audio media-understanding provider so Kesha is discoverable, and
holds no transcription code of its own. The transcript is produced by OpenClaw's
configured `type: "cli"` model entry, which runs the `kesha` command; the plugin
is not a second implementation of Transcription.

This is Maks's main workflow: voice notes in Telegram, transcribed on his own
laptop, no API key anywhere.

## Non-Goals

- Transcription itself. Neither the plugin nor the documented configuration
  specifies anything about how audio becomes text — see
  [transcription](../transcription/spec.md).
- Speaking. `kesha say` produces messenger-ready OGG/Opus, but the plugin does
  not register a synthesis capability; invoking it is left to a host hook or
  agent tool.
- Installing or updating OpenClaw itself, and the shape of OpenClaw's own
  configuration file beyond the keys this integration is documented against.
- The MCP server, which is a different integration for a different protocol —
  see [mcp-server](../mcp-server/spec.md).

## Requirements

### Requirement: The plugin ships inside the CLI package

The plugin manifest and its entry module SHALL be published as part of the CLI package and declared as an OpenClaw extension there, so installing the plugin needs no artifact the CLI install did not already deliver.

#### Scenario: Maks installs the plugin after installing the CLI

- GIVEN Maks has run `bun add -g @drakulavich/kesha-voice-kit`
- WHEN Maks runs `openclaw plugins install @drakulavich/kesha-voice-kit`
- THEN OpenClaw finds the manifest and entry module inside the package and
  registers the plugin

#### Scenario: The plugin files are dropped from the published package

- WHEN either plugin file stops being published
- THEN the plugin cannot be installed from npm at all, because no other artifact
  carries it

> *Technical Note — `openclaw.plugin.json` and `openclaw-plugin.cjs` are listed
> in `package.json#files`, and `package.json#openclaw.extensions` points at the
> `.cjs`. `package.json#openclaw.compat.pluginApi` and
> `#openclaw.build.openclawVersion` are required by ClawHub's publisher — see
> `docs/runbooks/openclaw-plugin.md`. The manifest's required fields are `id`
> and a JSON-Schema-shaped `configSchema`; `configPatch` is not a valid field
> and is silently discarded by the loader.*

### Requirement: The plugin registers a discoverable audio provider but does not transcribe

The plugin SHALL register a single audio media-understanding provider so Kesha is discoverable in `openclaw plugins inspect`. The registration SHALL be declaration-only: it SHALL NOT carry a transcription handler, link the Engine, embed a model, or reimplement any part of Transcription. Transcription is performed by OpenClaw's configured `type: "cli"` model entry, which runs the installed `kesha` command — not by the plugin.

#### Scenario: Maks inspects the installed plugin

- GIVEN the plugin is installed
- WHEN Maks runs `openclaw plugins inspect`
- THEN the plugin shows one media-understanding capability
  (`Shape: plain-capability`)

#### Scenario: Maks's agent receives a voice message

- GIVEN `kesha` is on PATH with the Engine and models installed, and
  `tools.media.audio.models` carries the documented `type: "cli"` entry
- WHEN a voice message reaches OpenClaw and audio understanding is enabled
- THEN OpenClaw's `type: "cli"` handler runs `kesha` on the audio and the agent
  sees the transcript text

#### Scenario: OpenClaw resolves a media-understanding provider for audio

- WHEN OpenClaw's provider path is offered this plugin's provider
- THEN it does not select it, because the provider carries no transcription
  handler and a local keyless CLI cannot satisfy the provider-auth gate that
  path requires

> *Technical Note — `register` in `openclaw-plugin.cjs` calls
> `api.registerMediaUnderstandingProvider` with `id: "kesha-voice-kit"`,
> `capabilities: ["audio"]`, `defaultModels: { audio: "parakeet-tdt-0.6b-v3" }`,
> and `autoPriority: { audio: 50 }` — and no `transcribeAudio`. The `Shape:
> plain-capability` in `plugins inspect` is derived from the provider id being
> registered, not from any handler (`derivePluginInspectShape`,
> `capabilityCount === 1`). OpenClaw's audio selection skips any provider without
> a `transcribeAudio` handler (`if (!provider.transcribeAudio) return null`), and
> the auth gate (`hasProviderAuthAvailable`) is only satisfiable for this
> provider by a literal `apiKey` on `models.providers.kesha-voice-kit` — a
> keyless local CLI has no sane way to set one. The ~45-line handler that spawned
> `kesha` was retired in #933 (see Open Issues).*

### Requirement: The plugin holds no install or download code

The plugin SHALL contain no install or download code path, so it cannot fetch the CLI, Engine, or models itself. The Never-auto-download rule applies to it exactly as it applies to the CLI: prerequisites must already be installed.

#### Scenario: A voice message arrives before `kesha install` was run

- GIVEN `kesha` is on PATH but no Engine is installed
- WHEN the documented `type: "cli"` path runs `kesha` on the audio
- THEN nothing is downloaded, `kesha` fails loudly with an actionable hint, and
  the agent receives no transcript

> *Technical Note — the prerequisites (`bun add -g`, then `kesha install`, plus
> `kesha install --tts` only if `kesha say` is used) are stated in the header
> comment of `openclaw-plugin.cjs` and in `docs/openclaw.md`. The entry module
> holds no runtime behaviour beyond the provider declaration.*

### Requirement: The plugin source carries no token that trips the `dangerous-exec` scanner

The plugin entry module SHALL NOT contain the substrings OpenClaw's `dangerous-exec` scanner treats as forbidden, anywhere in the file — comments included — because the scanner matches raw text rather than parsed code, and a match trips ClawHub's registry scan and `openclaw security audit` for an otherwise legitimate local-CLI wrapper.

#### Scenario: ClawHub scans the published plugin

- WHEN ClawHub's registry scan (and `openclaw security audit`) checks the entry
  module
- THEN no rule fires and the plugin passes

#### Scenario: An edit names the forbidden module in a comment

- WHEN a comment in the entry module spells the forbidden module name
- THEN ClawHub's registry scan and `openclaw security audit` flag it even though
  the code is unchanged

> *Technical Note — since #933 the entry module holds no subprocess call, so the
> `dangerous-exec` rule (a bare command-running call AND the forbidden module
> substring, both in one file, comments included) cannot fire. The prohibition
> still stands for future edits: an `Editing note` comment in the module and
> `docs/runbooks/openclaw-plugin.md` ("Comments count — it's a naive regex, not
> AST-aware") record it, and CLAUDE.md repeats it. The entry module is still
> CommonJS with `module.exports` because it runs inside OpenClaw's runtime, not
> Kesha's.*

### Requirement: Plugin distribution is independent of the CLI and Engine releases

Publishing the plugin to the OpenClaw registry SHALL be its own deliberate step, not a side effect of publishing the CLI to npm or cutting an Engine release.

#### Scenario: A CLI release is published

- WHEN a CLI version is published to npm
- THEN nothing is published to the OpenClaw registry as a result

#### Scenario: The registry listing goes stale

- GIVEN several CLI releases have shipped with no registry publish
- THEN the registry listing stays on its last published version, and nothing
  fails to report the drift

> *Technical Note — `docs/runbooks/openclaw-plugin.md` states the ClawHub
> publish is independent of npm publish, GitHub releases, and
> `build-engine.yml`, and that no CI lane performs it. `--force` overwrites an
> existing install; `openclaw plugins uninstall` is interactive with no
> non-interactive flag.*

## Open Issues

- **Resolved (#933): the registered provider was not the path that transcribes.**
  The `transcribeAudio` handler and its temp-file / spawn / parse / timeout /
  cleanup helpers were retired. The provider registration is now declaration-only
  — it keeps Kesha discoverable in `openclaw plugins inspect`
  (`Shape: plain-capability`) while removing the ~45 lines the documented config
  never reached. This also closes the two defects that lived only on that path
  (the temporary write outside the `try`, and the non-collision-safe
  `kesha-<pid>-<Date.now()><ext>` name). If a future OpenClaw release makes a
  keyless local provider selectable, re-add the handler then rather than
  restoring dead code speculatively.
- **The plugin is only lightly tested.** `tests/unit/openclaw-plugin.test.ts`
  loads `openclaw-plugin.cjs`, asserts the declaration-only registration (one
  audio provider, no `transcribeAudio` handler), and reproduces OpenClaw's
  `dangerous-exec` rule to confirm the source does not trip it. It does not
  install the plugin into a real OpenClaw and assert the live `plugins inspect`
  shape, and it couples to OpenClaw's current scanner regex — tracked in #934.
- `openclaw.plugin.json` advertises "25 languages" and "~19x faster than
  Whisper" independently of the README and `server.json`. Nothing keeps those
  claims in sync when the supported-language set changes.
- The documented `--timestamps` variant in `docs/openclaw.md` is a user-side
  configuration of the `type: "cli"` path — it is selected by the user's
  `models` entry, not by the plugin.

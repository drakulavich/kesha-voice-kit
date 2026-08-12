# OpenClaw Plugin Specification

## Purpose

The OpenClaw plugin gives an LLM agent ears: a voice message arriving in any
channel OpenClaw is connected to gets transcribed locally by Kesha before the
agent reads it. The plugin ships inside the CLI package and drives the `kesha`
command as a subprocess — it is a thin adapter, not a second implementation of
Transcription.

This is Maks's main workflow: voice notes in Telegram, transcribed on his own
laptop, no API key anywhere.

## Non-Goals

- Transcription itself. The plugin shells out to the CLI and specifies nothing
  about how audio becomes text — see [transcription](../transcription/spec.md).
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

### Requirement: Transcription runs through the installed CLI as a subprocess

The plugin SHALL obtain transcripts by invoking the installed `kesha` command as a subprocess and reading its machine-readable output. It SHALL NOT link the Engine, embed a model, or reimplement any part of Transcription.

#### Scenario: Maks's agent receives a voice message

- GIVEN `kesha` is on PATH with the Engine and models installed
- WHEN a voice message reaches OpenClaw and audio understanding is enabled
- THEN the audio is written to a temporary file, `kesha` transcribes it, and the
  agent sees the transcript text

#### Scenario: A request arrives with no audio

- WHEN the plugin is handed a request carrying no audio buffer
- THEN it returns an empty transcript without spawning anything

> *Technical Note — `transcribeAudio` in `openclaw-plugin.cjs:39-72` writes the
> buffer to `os.tmpdir()` keeping the original extension (defaulting to `.ogg`),
> runs `spawnSync("kesha", ["--json", tmp])`, and reads `parsed[0].text` from
> the result array. It reports the model id `parakeet-tdt-0.6b-v3` on success.
> The registered provider declares `capabilities: ["audio"]` and
> `autoPriority: { audio: 50 }` (`:75-84`).*

### Requirement: The plugin never triggers a download

The plugin SHALL require that the CLI, Engine, and models are already installed, and SHALL NOT download or install anything itself. The Never-auto-download rule applies to it exactly as it applies to the CLI.

#### Scenario: A voice message arrives before `kesha install` was run

- GIVEN `kesha` is on PATH but no Engine is installed
- WHEN a voice message reaches the plugin
- THEN nothing is downloaded, and the agent receives no transcript

#### Scenario: The CLI is not installed at all

- GIVEN `kesha` does not resolve on PATH
- WHEN a voice message reaches the plugin
- THEN the spawn fails and the plugin returns an empty transcript

> *Technical Note — the prerequisites (`bun add -g`, then `kesha install`, plus
> `kesha install --tts` only if `kesha say` is used) are stated in the header
> comment of `openclaw-plugin.cjs:14-18` and in `docs/openclaw.md`. The plugin
> holds no install code path.*

### Requirement: A failed transcription yields an empty transcript rather than a raised error

The plugin SHALL absorb every failure — spawn failure, non-zero exit, timeout, unparseable output — and return an empty transcript, so a bad audio message cannot crash the agent's message handling.

#### Scenario: The CLI exits non-zero on a corrupt attachment

- GIVEN a corrupt audio attachment
- WHEN the plugin transcribes it
- THEN `kesha` exits non-zero and the plugin returns an empty transcript
- AND the temporary file is deleted regardless

#### Scenario: Transcription outruns the timeout

- GIVEN a long recording and the default timeout
- WHEN transcription has not finished in time
- THEN the subprocess is stopped and the plugin returns an empty transcript
- AND a caller-supplied timeout is honoured in place of the default

> *Technical Note — every failure branch in `openclaw-plugin.cjs:50-70` returns
> `{ text: "" }`; the `finally` block unlinks the temporary file best-effort.
> `DEFAULT_TIMEOUT_MS` is 60 000 and is overridden by `req.timeoutMs`
> (`:30`, `:50`). This deliberately trades the corpus-wide "never swallow
> errors" rule for host stability — see Open Issues.*

### Requirement: Temporary audio never outlives the request

The plugin SHALL write the audio it was handed to a per-request temporary file under the system temporary directory and SHALL delete it once the request finishes, whether it succeeded or failed.

#### Scenario: A voice message is transcribed successfully

- WHEN the plugin finishes a successful transcription
- THEN the temporary audio file no longer exists

#### Scenario: Two messages are transcribed concurrently

- GIVEN two requests are in flight in the same host process
- WHEN both write temporary files
- THEN their paths differ, so neither overwrites or deletes the other's audio

> *Technical Note — `tempAudioPath` (`openclaw-plugin.cjs:33`) composes
> `kesha-<pid>-<timestamp><ext>` under `os.tmpdir()`. Deletion happens in the
> `finally` of `transcribeAudio` and swallows its own error.*

### Requirement: The plugin source carries no token that trips the host's scanner

The plugin entry module SHALL NOT contain the substrings OpenClaw's `dangerous-exec` scanner treats as forbidden, anywhere in the file — comments included — because the scanner matches raw text rather than parsed code, and a match blocks installation of an otherwise legitimate local-CLI wrapper.

#### Scenario: Maks installs the published plugin

- WHEN OpenClaw scans the entry module during installation
- THEN no rule fires and the plugin installs

#### Scenario: An edit names the forbidden module in a comment

- WHEN a comment in the entry module spells the forbidden module name
- THEN the scanner fires even though the code is unchanged, and the plugin is
  blocked

> *Technical Note — the module specifier is split across a `+` at
> `openclaw-plugin.cjs:25` precisely so the substring is absent from the source;
> the reason is recorded in the comment above it and in
> `docs/runbooks/openclaw-plugin.md` ("Comments count — it's a naive regex, not
> AST-aware"). CLAUDE.md repeats the prohibition. This is also why the entry
> module is CommonJS requiring Node built-ins rather than Bun-native APIs: it
> runs inside OpenClaw's runtime, not Kesha's.*

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

- **The registered provider is not the path that transcribes.** Per
  `docs/runbooks/openclaw-plugin.md`, OpenClaw routes audio through the
  `type: "cli"` entry in `tools.media.audio.models`, which spawns `kesha`
  directly; `registerMediaUnderstandingProvider` requires an API key via
  `requireApiKey()` and silently fails for local CLI tools, so the registration
  exists for discoverability only. On the documented default configuration
  `transcribeAudio` never runs — meaning most of the requirements above describe
  a code path users do not exercise. Worth an issue to either wire it up or
  retire it.
- **Nothing tests the plugin.** No unit or integration test loads
  `openclaw-plugin.cjs`, asserts its provider registration, or checks the
  scanner constraint. All of it is held by review and by the runbook.
- The swallow-everything error contract conflicts with the repository's "never
  swallow errors; never return success on failure" rule. An empty transcript is
  indistinguishable from silence that genuinely transcribed to nothing, so a
  misconfigured install looks like a quiet user.
- `openclaw.plugin.json` advertises "25 languages" and "~19x faster than
  Whisper" independently of the README and `server.json`. Nothing keeps those
  claims in sync when the supported-language set changes.
- The plugin passes `--json` without `--timestamps`; the timestamped variant
  documented in `docs/openclaw.md` is a user-side configuration of the
  `type: "cli"` path, not something the plugin can select.

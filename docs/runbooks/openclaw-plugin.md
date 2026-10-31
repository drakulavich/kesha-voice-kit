# OpenClaw plugin runbook

Read this when editing the OpenClaw plugin or publishing it to ClawHub.

## OpenClaw plugin

The plugin lives in `openclaw.plugin.json` + `openclaw-plugin.cjs` (+ `package.json#openclaw.extensions`).

**How audio transcription actually works in OpenClaw:** the `type: "cli"` path in `tools.media.audio.models` — NOT `registerMediaUnderstandingProvider`. OpenClaw only routes audio to a media-understanding provider once model auth resolves for it (`hasProviderAuthAvailable`, ultimately an API key); a local, keyless CLI cannot satisfy that on any sane config, so the provider is never selected to run. The actual transcription routes through OpenClaw's `type: "cli"` handler, which runs `kesha {{MediaPath}}` and captures bare transcript stdout.

The plugin still registers a `MediaUnderstandingProvider` — **declaration-only, for discoverability** (`openclaw plugins inspect` shows `Shape: plain-capability`, driven by the provider id being present, not by any handler). It carries no `transcribeAudio` handler, because the documented config never reaches one (#933). If a future OpenClaw release makes a keyless local provider selectable, re-add the handler then — don't restore dead code speculatively.

Recommended user config:
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          {"type":"cli","command":"kesha","args":["{{MediaPath}}"],"timeoutSeconds":15}
        ],
        echoTranscript: true,
        echoFormat: '🦜 "{transcript}"'
      }
    }
  }
}
```
This is a documented user-config default, not a plugin manifest patch.

**Scanner rules:**
- OpenClaw's `dangerous-exec` scanner fires when a file contains BOTH a `spawn(`/`exec(`-style call AND the substring for the forbidden module name. **Comments count** — it's a naive regex, not AST-aware. Since OpenClaw `2026.7.1-2`, local `openclaw plugins install` does not run this check; ClawHub's registry scan and `openclaw security audit` do, which is why the source-level prohibition still matters.
- The entry module holds no subprocess call (#933), so the rule cannot fire today. The prohibition stands for future edits: never name the forbidden module name or a bare command-running call anywhere in `openclaw-plugin.cjs`, not even in comments. If you ever re-add a subprocess call, split the module specifier across `+` so the forbidden substring stays out of the source.
- `--force` flag overwrites existing installs. `openclaw plugins uninstall` is interactive (no `--yes`).

**Manifest:** required fields are `id` + `configSchema` (proper JSON Schema shape). `configPatch` is NOT a valid field — the loader silently discards it.

## Publishing the OpenClaw plugin to ClawHub

The plugin is distributed on [ClawHub](https://clawhub.com) (the OpenClaw plugin registry) as its own outward-facing step: neither the `kesha` npm publish nor a GitHub release triggers it.

**`package.json#openclaw` must carry the publish metadata** — without it `clawhub package publish` fails with the opaque `Error: package.json required` even though the file exists. A ClawHub **code plugin** needs all three keys (mirror an `@openclaw/*` package such as `@openclaw/imessage`):

```jsonc
"openclaw": {
  "extensions": ["./openclaw-plugin.cjs"],
  "compat": { "pluginApi": ">=<openclaw-version>" },   // min host API the plugin needs
  "build":  { "openclawVersion": "<openclaw-version>" } // version it was built/validated against
}
```

Use the current `openclaw --version` (e.g. `2026.5.27`) for both unless you have evidence the plugin works against an older API. Bump `build.openclawVersion` whenever you re-publish after validating against a newer OpenClaw.

**Publish flow** (CLI is `clawhub`, installed alongside `openclaw`):

1. **Auth + scope.** `clawhub whoami` must report the owner that matches the package scope — `@drakulavich/kesha-voice-kit` → owner `drakulavich`. If not logged in, the user runs `clawhub login` (interactive — suggest `!clawhub login`; the agent cannot complete the browser/device step).
2. **Publish from a clean checkout at the released tag**, never the root checkout (it goes stale). Provenance flags are recorded on the registry entry and `--source-repo`/`--source-commit` must be set together:
   ```bash
   git worktree add .worktrees/clawhub vX.Y.Z
   cd .worktrees/clawhub
   clawhub package publish . \
     --family code-plugin \
     --version X.Y.Z \
     --source-repo drakulavich/kesha-voice-kit \
     --source-commit <sha-of-vX.Y.Z> \
     --source-ref vX.Y.Z \
     --changelog "<one-line summary>"
   ```
3. **No `--dry-run` in the shipped `clawhub` (2026.5.x)** despite what the docs site shows — the only validation is the real publish, which is server-side scanned and **held in review** ("may stay out of install/download surfaces until review finishes"). Treat publish as the commit point; get the `package.json` metadata right first.
4. **Verify** with `clawhub search kesha` / `openclaw plugins search kesha-voice-kit`, and that `openclaw plugins install clawhub:@drakulavich/kesha-voice-kit` resolves once review clears.

Gotcha: `clawhub package publish` reads the **local folder's** `package.json` for validation, but records the `--source-*` flags as provenance — keep them consistent (publish from the same commit the metadata lives on, so the recorded source actually contains the `openclaw.compat`/`build` block).

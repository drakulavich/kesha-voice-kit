---
paths:
  - "openclaw.plugin.json"
  - "openclaw-plugin.cjs"
---

# OpenClaw plugin

The plugin routes audio through the `type: "cli"` path in `tools.media.audio.models`. Its `dangerous-exec` scanner is a naive regex that also reads comments — never name a forbidden module substring anywhere in `openclaw-plugin.cjs`, not even in a comment. Runbook: `docs/runbooks/openclaw-plugin.md`.

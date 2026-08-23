# The conveyor loop

The loop is the standalone conveyor's RUNBOOK.md — read it in the checkout the
`conveyor` command comes from. The command is a `bun link` symlink, so the
checkout is discoverable from the binary itself:
`readlink -f "$(which conveyor)"` names `<checkout>/src/cli.ts`, and the
RUNBOOK sits at that checkout's root. This file records only what kesha does
differently; for anything unstated, the RUNBOOK is the text.

## Deltas

- **Profile and state**: `conveyor.config.json` at the kesha root (gitignored;
  never committed — it names the real repository and maintainer). Queue and
  state live in the conveyor checkout under `state/drakulavich--kesha-voice-kit/`.
- **Reviewer**: `conveyor review-prompt --pr <P> --claim "<claim>" > /tmp/review-<P>.md`,
  then `grok --prompt-file /tmp/review-<P>.md --sandbox read-only` in the
  background, log at `.omc/review-<pr>-<sha8>.log`. The prompt goes in by
  path, never through argv — the RUNBOOK's own rule, and one large diff is
  all it takes to prove it. Findings
  land as one `**grok review**` comment carrying the full head SHA and every
  material finding. Greptile is the trigger-driven second reviewer; its
  Confidence Score is never a gate.
- **Worktrees**: `just worktree <slug> <branch>` from the root checkout only;
  removed by `conveyor close --apply` for a queue ticket, `just worktree-rm <slug>`
  otherwise.
- **Verification**: `just preflight` before every push; `just mutate` for
  revert-to-red proof.
- **Gate and close**: `conveyor evidence <provider> <uri> --pr <P>`, then
  `conveyor gate --issue <N> --pr <P> --evidence <path> --apply`, then after a
  human merges, `conveyor close --issue <N> --pr <P> --apply`.

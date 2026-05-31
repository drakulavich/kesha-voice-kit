# jj + Git LFS Runbook

> Extracted from CLAUDE.md (chore/slim-claudemd, 2026-05-31) to keep the always-loaded
> instructions under Claude Code's 40k-char performance threshold. Read this when using jj
> in this repo, or when jj shows LFS-managed files as modified.

## JJ + Git LFS workaround

This repo uses Git LFS for fixtures/assets. Stock `jj` can surface LFS-managed files as modified in colocated repos. Use the LFS fork until upstream support lands:

```bash
cargo install --git https://github.com/gusinacio/jj.git \
  --branch lfs --locked --bin jj jj-cli
jj config set --user git.ignore-files '["lfs"]'
git lfs pull
```

Operational lessons from the 2026-05-16 setup:

- If `jj --version` still shows Homebrew's binary, `which -a jj` usually lists `/opt/homebrew/bin/jj` before `~/.cargo/bin/jj`; run `brew unlink jj`. The fork reporting `jj 0.35.0-<sha>` is expected.
- Preserve identity after switching: `jj config set --user user.name "<Your Name>"` and `jj config set --user user.email "<your@email.com>"`; use your own credentials, never the repo owner's.
- Existing `.jj`: do not reclone. Keep the colocated checkout, set config, run `git lfs pull`, verify `jj status`.
- Normal agent isolation: follow "AGENTS MUST WORK IN ISOLATED TREES FROM FRESH MAIN" above. Use a Git worktree or a separate JJ workspace from fresh `origin/main` / `main@origin`, then edit only inside that isolated tree.
- Disk model: changes/bookmarks share history and are cheap, but they do not isolate the on-disk working copy. Agent tasks need physical workspace isolation even if that duplicates `node_modules`, `rust/target`, temp caches, and materialized LFS files.
- A JJ workspace may lack `.git`; inspect with `jj status` / `jj diff` / `jj log`, and use `gh -R drakulavich/kesha-voice-kit ...` for GitHub operations.
- Before calling files "external changes", distinguish dirty edits from a stale checked-out feature branch: check `jj status` + `jj workspace list` everywhere; in the colocated checkout also `git status --short --branch` + `git log --oneline --decorate -5`. After a PR merges and the remote branch is deleted, fetch, move back to `main`, then start the next task.
- If JJ looks suspicious, trust Git as the source of truth: `git status --short --branch` must be clean before release/PR decisions.

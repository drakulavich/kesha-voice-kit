## 1. Engine (Rust): audio open path, error classes, owner watch, progress events

- [ ] 1.1 S2-2 sample rate 0 → `E_BAD_AUDIO` naming the file, no panic text on stderr
- [ ] 1.2 S2-3 AIFF decodes (symphonia `aiff`) or the claim and message are corrected
- [ ] 1.3 S2-4 `--no-vad` over the ceiling → `E_INVALID_ARG`
- [ ] 1.4 S3-F4 `record --out` directory / symlink / unwritable → `E_INVALID_ARG` with the OS reason
- [ ] 1.5 S3-F1 `record` stops when its parent dies (getppid / stdin EOF)
- [ ] 1.6 S11-3 diarization progress obeys `--quiet`
- [ ] 1.7 S8-8 `transcribe` emits `progress` events (backend loaded, segment N of M); fake engine mirrors them

## 2. Signals (TS)

- [ ] 2.1 S1-4 / S6-4 interrupted run → `E_INTERRUPTED`, never `E_INTERNAL`; `docs/errors.md` row; pins
- [ ] 2.2 S6-5 the line names the signal received, not the escalated SIGKILL
- [ ] 2.3 S6-2 no queued file starts after the first signal
- [ ] 2.4 S6-3 SIGHUP handled like SIGTERM

## 3. Argument handling (TS)

- [x] 3.1 S1-5 / S2-5 / S9-F3 unknown flags refused before any spawn, exit 2, suggestion line
- [x] 3.2 S1-1 usage with no input → stderr, `E_INVALID_ARG`, exit 2, empty stdout
- [x] 3.3 S9-F2 every CLI-level usage error prints `error [E_INVALID_ARG]: …`
- [x] 3.4 S9-F1 CLI-origin `E_INVALID_ARG` on the transcribe path exits 2
- [x] 3.5 S10-1 `completions` without a shell → stderr, `E_INVALID_ARG`, exit 2
- [x] 3.6 S3-F3 global flag before a subcommand routes to it, or is refused with the correct shape

## 4. Channels and language (TS)

- [x] 4.1 S1-2 `--verbose` diagnostics on stderr
- [x] 4.2 S1-3 language-mismatch warning prints under `--quiet`
- [x] 4.3 S3-F2 `record` result lines print under `--quiet`
- [x] 4.4 S11-1 `--lang` compares case-folded primary subtags
- [x] 4.5 S11-2 / S11-4 `LANG_ROUTING_FLOOR` for `lang`; raw fields unchanged; `--verbose` names the floor

## 5. Diagnostics and Stats (TS)

- [x] 5.1 S5-F1 `versionMarker` (and every path-bearing string) redacted in doctor/support-bundle
- [x] 5.2 S5-F2 `stats export` without `--format` → usage line, exit 2
- [x] 5.3 S5-F3 `stats retention -5` rejected, exit 2
- [x] 5.4 S5-F4 support-bundle report on stderr
- [x] 5.5 S9-F5 engine debug events reach the diagnostic log

## 6. MCP and core API (TS)

- [ ] 6.1 S8-1 aborted `transcribe()` rejects with `KeshaError` `E_INTERRUPTED`
- [ ] 6.2 S7-1 MCP cancel forwards the signal; no engine survives a cancel
- [ ] 6.3 S7-2 `kesha mcp` exits on stdin EOF with a call in flight
- [ ] 6.4 S8-2 `downloadEngine` exported; CLAUDE.md sentence updated
- [ ] 6.5 S8-3 `transcribe()` on a directory → `E_INVALID_ARG` before any spawn

## 7. Lifecycle (TS)

- [x] 7.1 S4-F1 `init` cancelled at a prompt exits 130
- [x] 7.2 S4-F2 stale install lock (dead pid, same host) is broken; hint printed at the start of the wait
- [x] 7.3 S10-2 completions fall back to file paths for the audio argument in bash, zsh and fish

## 8. Integration

- [ ] 8.1 Merge the seven cluster branches into `xt-major`; reconcile the two `E_INTERRUPTED` rows; `just preflight`
- [ ] 8.2 Spec deltas for every modified capability listed in the proposal; `bun run check:specs`
- [ ] 8.3 PR; Greptile P1/P2 clear; adversarial review aimed at "every major finding's reproduction command now behaves as its sheet states, and no minor finding regressed"; CI on the full head SHA
- [ ] 8.4 After merge: sync and archive in a follow-up PR

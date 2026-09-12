## 1. CLI

- [x] 1.1 `forwardStdout` passes a completion callback to `process.stdout.write` and flips a reader-left flag on EPIPE, once
- [x] 1.2 After the flag flips, the relay keeps draining without writing
- [x] 1.3 `recordEngine` sends the Engine one `SIGTERM` when the flag flips; the exit is judged by the existing live-stop rule

## 2. Tests

- [x] 2.1 Contract case: a fake Engine printing ten lines over three seconds, piped into `head -1`, exits 0, delivers the first line, and never reaches its finished-naturally marker
- [x] 2.2 `just mutate` catches deleting the `SIGTERM` and dropping the write callback

## 3. Spec

- [ ] 3.1 Sync this delta into `openspec/specs/audio-recording/spec.md` and archive the change after PR #1195 merges

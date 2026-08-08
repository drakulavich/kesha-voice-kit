## 1. Diagnosis

- [x] 1.1 Confirm the failure is the header phase, not the download, by checking ureq's `recv_response` vs `recv_body` semantics
- [x] 1.2 Compare file sizes in the HuggingFace repo to isolate why only one file fails (654 MB vs 179 MB next largest)
- [x] 1.3 Verify the origin is healthy from outside CI (direct fetch ~5 MB/s) so the fix targets latency-to-first-byte, not bandwidth
- [x] 1.4 Confirm the same file succeeds on the windows runner, proving the body path is unaffected

## 2. Implementation

- [x] 2.1 Add `RECV_RESPONSE_TIMEOUT` alongside the other download-tuning constants, with a doc comment recording the measurement behind the number
- [x] 2.2 Point `timeout_recv_response` at the constant in `download_attempt`
- [x] 2.3 Extend the existing timeout comment to explain that `recv_response` bounds headers and why resolve/connect stay tight
- [x] 2.4 Leave resolve, connect, send-request, and the unbounded body untouched

## 3. Verification

- [x] 3.1 `cargo fmt --check`
- [x] 3.2 `cargo clippy --all-targets -- -D warnings`
- [x] 3.3 `make rust-test` (nextest, 425/425)
- [x] 3.4 `bunx tsc --noEmit` and `bun test`
- [ ] 3.5 CI green on the PR, including `release-branch-engine-smoke`, which downloads the file that exposed the bug — this is the real assertion
- [ ] 3.6 Greptile review clear of P1/P2

## 4. Follow-through

- [ ] 4.1 Merge, then bring `release/1.24.8` up to date so the v1.24.8 engine release carries the fix
- [ ] 4.2 Confirm #777 auto-closed
- [ ] 4.3 Archive this change once the release ships

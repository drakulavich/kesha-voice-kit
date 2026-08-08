## Why

`kesha install --tts ru` fails with `E_MODEL_DOWNLOAD` on a healthy network. The download path bounds how long an origin may take to send response *headers* at 30 s, but HuggingFace reconstructs Xet-deduplicated objects before answering, and our largest artifact — the 654 MB vosk bert model — routinely needs longer than that to start responding. The retry budget then burns all five attempts against the same wall and the install gives up.

It surfaced as a hard release blocker: `release-branch-engine-smoke` failed 4 of 4 runs over an hour on the v1.24.8 release PR, always on that one file, while every smaller file in the same HuggingFace repository downloaded fine on the same runners (#777).

## What Changes

- Raise the response-header timeout on model downloads from 30 s to 120 s, sized for Xet reconstruction of the largest artifact we host.
- Name the value as a constant with the reasoning attached, so the next reader does not trim it back to a tidier-looking number.
- Leave the resolve, connect, and send-request timeouts at 10 s: those are what actually catch an unreachable host, and they must keep failing fast.
- Leave the response *body* unbounded, unchanged — that decision is already documented and correct.

Not a breaking change: no interface, flag, or output moves.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `installation`: adds a requirement that model downloads tolerate an origin that is slow to *begin* responding, while still failing fast when the host is unreachable. The spec currently says what gets downloaded and when, but says nothing about resilience, so the 30 s bound was an undocumented implementation choice with user-visible consequences.

## Impact

- `rust/src/models.rs` — `download_attempt`'s ureq configuration and one new constant.
- Affects every model download, not just the vosk bert file; the practical effect elsewhere is nil, because a fast origin never approaches either bound.
- Failure latency for the rare "host accepts the connection, then black-holes" case grows from 5 × 30 s to 5 × 120 s per file. Accepted: resolve and connect already cover the common unreachable-host cases within 10 s each, and an install that reaches this state is already failing.
- Unblocks the v1.24.8 engine release (#776).

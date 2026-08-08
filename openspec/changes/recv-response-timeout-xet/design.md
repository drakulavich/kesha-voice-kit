## Context

`download_attempt` in `rust/src/models.rs` configures ureq explicitly, because ureq ships no timeouts at all and a host that accepts a connection and then goes quiet would hang the install forever. Four phases are bounded today:

| phase | bound | catches |
| --- | --- | --- |
| `timeout_resolve` | 10 s | DNS that does not answer |
| `timeout_connect` | 10 s | unreachable host |
| `timeout_send_request` | 10 s | connection that stalls mid-request |
| `timeout_recv_response` | 30 s | origin that took the request, then went quiet |
| body | *unbounded* | — deliberately: the 2.4 GB encoder legitimately streams for hours |

In ureq, `recv_response` and `recv_body` are **separate phases**: the former bounds receiving the response *headers*, the latter the download. The existing comment reasons carefully about why the body must stay unbounded, but the same "large artifacts are legitimately slow" argument was never applied to header latency.

HuggingFace stores large files Xet-deduplicated and reconstructs them from chunks before it can answer. For a 654 MB object that reconstruction exceeds 30 s. Measurements from #777:

- `bert/model.onnx` (654 361 598 B) — failed 4/4 on ubuntu runners, every attempt exactly at the 30 s bound
- `model.onnx` (179 314 533 B), `dictionary` (101 431 118 B), `bert/vocab.txt` (1 780 720 B) — all fine, same repository, same runners
- the same file on a **windows** runner in the same matrix: headers arrived, then the body streamed for 3 m 40 s and completed
- the same URL from a laptop: 20 MB in 3.9 s (~5 MB/s), so the origin is healthy, just slow to *start*

## Goals / Non-Goals

**Goals:**

- `kesha install --tts ru` completes against an origin that needs more than 30 s to produce headers.
- An unreachable host still fails within seconds, not minutes.
- The chosen number carries its reasoning in the source, so it survives future tidying.

**Non-Goals:**

- Bounding the response body. That decision stands.
- Reworking the retry schedule, attempt counts, or `Retry-After` handling (#724 territory).
- Mirroring model downloads in CI — a real option for the same symptom, tracked separately as #741, and orthogonal to the user-facing bug.
- Per-file timeouts keyed on artifact size. Rejected below.

## Decisions

**Raise `timeout_recv_response` to 120 s.**

Sized to clear the worst observed case with headroom, while staying far below anything a user would read as a hang. 60 s would clear the measured failures but leaves no margin on a slower path; 300 s stops being a timeout in any useful sense.

*Alternative considered — keep 30 s and mirror the file.* That fixes CI and leaves every user hitting the same wall on `kesha install --tts ru`. The mirror is worth doing for CI throughput (#741), but it is not the fix for this defect.

*Alternative considered — scale the timeout by expected file size.* `ModelFile` has no size field today, adding one duplicates a fact the server already reports, and the relationship between object size and reconstruction latency is not something we can predict. A single generous bound is simpler and no less safe.

**Extract a named constant rather than editing the literal.**

`RECV_RESPONSE_TIMEOUT` sits with the other download-tuning constants (`MAX_DOWNLOAD_ATTEMPTS`, `RETRY_MAX_DELAY`, `RETRY_AFTER_MAX`), each of which already carries a doc comment explaining its number. A bare `Duration::from_secs(120)` inline reads like an arbitrary bump and invites exactly the "that looks high, let me trim it" edit that would reintroduce the bug.

**Leave resolve/connect/send-request at 10 s.**

These are what make a dead host fail fast, and they are unaffected by origin-side reconstruction latency. Keeping them tight is what makes the longer header bound safe.

## Risks / Trade-offs

**A host that accepts the connection and then black-holes now takes 5 × 120 s = 10 min per file instead of 5 × 30 s.** → Accepted. Reaching that state means resolve and connect both succeeded, so the host is up and answering TCP — a genuinely rare failure mode, and one where the install is already doomed. The common unreachable-host cases still fail inside 10 s each. Shrinking the attempt count to compensate would trade a rare slow failure for a real loss of resilience against 429s, which is the failure mode we actually see (#724).

**The number is empirical, not derived.** → It is pinned to a measurement recorded in the constant's doc comment and in #777, so a future reader can re-evaluate it against evidence rather than taste. If HuggingFace changes how Xet serves large objects, the comment says what to re-measure.

**No automated test covers the timeout value.** → A test that genuinely exercises a 120 s header stall would take two minutes of wall clock to assert a constant. The behaviour is verified where it actually failed: `release-branch-engine-smoke` downloads this exact file, and its result on the release PR is the check.

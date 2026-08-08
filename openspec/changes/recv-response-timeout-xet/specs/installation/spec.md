## ADDED Requirements

### Requirement: Model downloads tolerate a slow origin but not an unreachable one

Model and Engine downloads SHALL distinguish an origin that is slow to *begin*
responding from a host that cannot be reached. The Engine SHALL allow the origin at
least 120 seconds to send response headers, because content-addressed stores
reconstruct large objects before answering and our largest artifact needs longer than
a minute to do so. DNS resolution, connection, and request submission SHALL each stay
bounded at 10 seconds, so an unreachable host still fails within seconds. The response
*body* SHALL remain unbounded: multi-gigabyte artifacts legitimately stream for hours
on a slow link.

#### Scenario: Ira installs Russian TTS over a slow-to-answer origin

- GIVEN the origin needs more than 30 seconds to send response headers for the
  654 MB vosk bert model
- WHEN Ira runs `kesha install --tts ru`
- THEN the Engine waits for the headers rather than treating the delay as a failure
- AND the file downloads and its pinned SHA-256 is verified
- AND the process exits 0

#### Scenario: Maks installs while the download host is unreachable

- GIVEN the download host does not accept connections
- WHEN Maks runs `kesha install`
- THEN each attempt fails within seconds rather than waiting out the header budget
- AND the error names the file that could not be fetched
- AND the process exits 1

#### Scenario: Ira's connection is slow but steady

- GIVEN the origin answers promptly but the link delivers the 2.4 GB encoder slowly
- WHEN Ira runs `kesha install`
- THEN the download is not interrupted by any deadline
- AND the install completes however long the transfer takes

> *Technical Note — source: `rust/src/models.rs::download_attempt`. The header budget is
> `RECV_RESPONSE_TIMEOUT`; `timeout_resolve` / `timeout_connect` / `timeout_send_request`
> hold the fast-failure guarantee. ureq treats `recv_response` (headers) and `recv_body`
> (download) as separate phases, and only the former is bounded. Sized against
> HuggingFace Xet reconstruction of `models/vosk-ru/bert/model.onnx` (#777).*

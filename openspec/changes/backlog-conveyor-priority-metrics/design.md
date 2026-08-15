# Design — backlog conveyor priority and lifecycle metrics

## Context

The existing conveyor treats GitHub facts and trusted versioned markers as its durable
boundaries. Phase 3 adds a deliberately mechanical priority policy and aggregate lifecycle
measurements without making the authenticated account or opaque provider field authoritative.

## Decisions

### Priority is manifest input, not prose inference

`prioritize` reads a JSON manifest with `version: 1`, a positive existing open issue number, an opaque
non-empty opaque provider of at most 256 trimmed characters, dimensions `impact`, `urgency`, `unblock`, and `riskReduction` in 0..5,
`confidence` and `effort` in 1..5, plus a concise trimmed non-empty rationale of at most 280 characters. It never accepts a
caller score. The canonical score is rounded to two decimals from
`((4*impact + 3*urgency + 2*unblock + 2*riskReduction) * confidence / effort)`.

The applied comment is a versioned structured marker containing the normalized assessment and
computed score. Only `OWNER`, `MEMBER`, and `COLLABORATOR` comments are trusted. Valid
lookalikes from another association are ignored. A trusted marker carrying the real prefix but
malformed payload is an operational failure, so partial or compromised trusted state cannot
silently affect ordering. Markers order by `(createdAt, databaseId)`, and the latest trusted
assessment wins. Under `--apply`, the marker is posted, its REST response comment id is parsed,
and every comment page is read again; the command reports acceptance only if that exact posted id
is still current. Identity compares every normalized assessment field, including opaque provider
and rationale, but excludes derived score and comment transport; identical current input is
idempotent with no new comment.

### Queue is a complete, deterministic GitHub view

`queue` reads all open issues and all relevant issue-comment pages through REST `per_page=100`
pages from 1 through a finite cap, stopping only on a short page and failing at a cap without one.
It excludes WIP, needs-decision, and wontfix labelled issues, and it never includes pull requests.
Optional label filtering is exact. `--limit` is an integer in 1..1000 applied after sorting.
The result sorts assessed issues by descending score, then oldest
`createdAt`, then issue number; visible unassessed issues have score zero and come after every
assessed issue. It emits component dimensions and rationale, not an inferred explanation. Any
page cap, malformed response, or malformed trusted marker fails closed.

### Metrics use only GitHub lifecycle facts and trusted gate markers

`metrics --since` rejects a lower bound after an injected `now`, captured before reads, and
evaluates facts at that fixed upper bound, making tests deterministic; bounds are an event filter,
not a transactional snapshot. It reports stable JSON keys and nullability for the bounds, merged PR count, gated PR count,
current WIP count, and current merge-ready count. Merged counts and merge-ended samples include
only `mergedAt` in `[since, now]`; gated counts and open→gate samples include only trusted marker
creation times in `[since, now]`; and merge-ended samples allow an earlier valid gate. Current WIP
counts scan all open issues and merge-ready counts scan all open pull requests regardless of
`since`. A historical gate is the newest valid marker by `(createdAt, databaseId)`, independent
of open-PR gate eligibility: it is trusted, strict/digest-valid, has marker PR equal to its
comment container, marker issue equal to the PR's sole closing issue, and evidence SHA equal to
the PR head. A PR without exactly one closing issue is simply ungated, not a report error; the
closing-issue read occurs only after a trusted container/head-matching candidate marker exists. For valid chronology
it calculates durations in seconds for `open→gate`, `gate→merge`, and `open→merge`; each reports sample size,
median (average of middle pair for even samples), and nearest-rank p90 on sorted values. A missing
sample is null, never zero. Negative, non-finite, or otherwise invalid durations are rejected
rather than clamped. Gate times come only from trusted valid gate markers; the ignored local ledger
is never read. Complete pagination and parsing are prerequisites to a report.

## Risks / Trade-offs

- Issue comments have concurrent writers. Rereading after an applied marker favours truthful
  current-state reporting over claiming a now-superseded write was accepted.
- GitHub list endpoints expose a finite per-page API. Reaching a configured cap is a failure,
  rather than silently reporting a partial queue or metric.
- Scores describe an explicit policy, not objective truth; the rationale and components remain
  visible for review.

## Open Questions

- None. The owner-approved issue body fixes the scoring weights and command surface.

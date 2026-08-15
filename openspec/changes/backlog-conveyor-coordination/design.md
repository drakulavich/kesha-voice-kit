# Design — backlog conveyor coordination

## Context

The Phase 1 conveyor already treats GitHub labels and versioned comments as durable
coordination state while leaving local prose non-authoritative. This change adds two
boundaries with different scopes: GitHub-backed path claims coordinate repository work
across hosts, and a filesystem lease serializes heavy work only on one host.

## Decisions

### One manifest drives path coordination

`plan`, `claim`, and `release` take `--manifest <path>`. The JSON object is self-versioned
and contains only `version: 1`, positive `issue`, non-empty opaque `holder`, normalized
repository-relative `paths`, and bounded `ttlSeconds`. A path is either an exact file or a
directory prefix; `*`, absolute paths, dot segments, empty segments, and trailing slashes
are rejected. Canonical path ordering makes equivalent manifests deterministic.

Claims are versioned issue-comment markers. A matching release marker makes prior claims
inactive; expired, released, closed, or non-WIP claims are inactive. Every relevant issue
and comment page is re-read before a decision. Only markers from an `OWNER`, `MEMBER`, or
`COLLABORATOR` have scheduling effect, matching the Phase 1 comment trust boundary. A
candidate's ordering key is GitHub comment creation time followed by database id. Candidates
are accepted by an ordered sweep: accept a candidate only when it overlaps no earlier
accepted candidate. A losing candidate is inactive for every later decision, which prevents
a loser that overlaps two paths from creating a transitive phantom lock. The holder remains
opaque and is never compared to an account name.

Acceptance is evaluated against earlier accepted claims that were live at the candidate's
creation time. Expiry or release controls present blocking only; it never resurrects a
historical loser, while a new marker created after expiry or release competes normally.

The manifest identity is the canonical version, issue, holder, paths, and TTL tuple. A live
accepted claim with that identity is an idempotent re-claim, not a renewal; its expiry stays
unchanged. Re-claiming after expiry publishes a new marker and starts a new TTL. The candidate
issue's own accepted claim, closing pull requests, and matching issue worktree are rendered
as self metadata but excluded from blocking edges, so a lane can re-plan after editing its
own files.

`plan` is read-only and reports a deterministic graph against live claims, open pull-request
file changes, and changed/untracked files from active local worktrees. `claim --apply`
writes only when the same live claim does not already exist, then re-reads facts and reports
acquired only if the caller's claim is the ordering winner. `release` reports its release
marker by default and writes it only under `--apply`; repeating it is idempotent.

### A hard-linked lease file gives the host one atomic winner

The lease root is a real non-symlink directory below `git rev-parse --path-format=absolute
--git-common-dir`. Resource names have a restricted filename grammar; the lease root and
every state file are lstat-checked before use. A complete state document is written to a
private temporary file and atomically published with an exclusive hard link, so a contender
can never observe or own a partially-written winning state.

A live lease from another holder is a refusal. Repeating acquisition by the same holder is
idempotent. An atomically-created per-resource operation guard serializes expiry recovery
and release, so a stale reclaimer cannot unlink a lease another reclaimer just published.
A guard that survives a crashed operation is fail-closed rather than guessed away. Expired
well-formed state is removed only while that guard is held. Release accepts only the recorded
holder and removes only a live, well-formed lease; expired or absent state is already
released. `status` never creates lease storage. Unknown, malformed, symlinked, or escaping
state is refused rather than removed.

### Existing report and execution conventions remain the public boundary

All commands use the existing report schema version and map a refusal to exit 4, an
invariant collision to exit 2, and an invalid external response or filesystem condition to
exit 3. Mutations are dry-run by default. GitHub and Git calls use argv arrays through the
existing runner; filesystem parsing validates data before a decision or mutation.

## Risks / Trade-offs

- GitHub comments cannot reserve a path before they exist. The post-write re-read and stable
  tie-break make the loser explicit instead of falsely reporting both claims acquired.
- Lease state is deliberately host-local. A network filesystem or second machine is outside
  the scope and must use the GitHub boundary instead.
- A malformed state is not reclaimed automatically. Fail-closed behavior is preferable to
  deleting another process's unknown ownership record.

## Open Questions

- None. The lease TTL is intentionally supplied per command rather than promoted to a
  repository-wide scheduling policy.

## ADDED Requirements

### Requirement: The conveyor SHALL plan and claim repository path ownership without provider identity

The conveyor SHALL accept a self-versioned claim manifest with a positive issue number,
opaque non-empty holder, normalized repository-relative exact-file or directory-prefix
paths, and bounded TTL. `plan`, `claim`, and `release` SHALL retain the Phase 1 JSON report,
dry-run, and exit-code conventions. A claim plan SHALL classify each overlap as `claim`,
`pull-request`, or `worktree`; glob paths are invalid. Active claims SHALL be only those on
open WIP issues that are unexpired and not explicitly released, and whose comment marker is
from an OWNER, MEMBER, or COLLABORATOR. Active candidates SHALL be selected by an ordered
`(created_at, database_id)` sweep that excludes every candidate overlapping an earlier
accepted candidate; a losing candidate SHALL NOT block later paths. A candidate issue's own
accepted claim, closing pull request, and matching issue worktree SHALL be self metadata,
not blocking edges. `claim --apply` SHALL re-read paginated facts after publishing its marker
and SHALL report acquired only for an accepted claim. A repeated accepted live claim with the
same canonical manifest identity SHALL be idempotent without renewing its expiry; a claim
after expiry starts a new TTL. Release SHALL be idempotent, including when holders share one
GitHub identity.

The ordered sweep SHALL compare each candidate with earlier accepted claims that were live at
the candidate's creation time. Expiry or release SHALL stop current blocking without
resurrecting a historical loser; a new marker created after expiry or release SHALL compete
as a new candidate.

#### Scenario: Ira previews all three collision sources

- GIVEN Ira's normalized manifest plans `scripts/backlog.ts`
- AND an active claim, an open pull request, and an active worktree each change that path
- WHEN Ira runs `bun run conveyor -- plan --manifest claim.json --json`
- THEN the report classifies one edge for each source
- AND no GitHub comment or local state changes

#### Scenario: Ira re-plans her own edited lane

- GIVEN Ira's manifest issue has a closing pull request and matching issue worktree that
  change one planned path
- WHEN Ira runs `bun run conveyor -- plan --manifest claim.json`
- THEN those records are reported as self metadata
- AND they do not block Ira's repeated live claim

#### Scenario: Maks loses an overlapping concurrent claim

- GIVEN Ira and Maks apply different opaque holders for overlapping paths on open WIP issues
- AND Ira's marker sorts first by `(created_at, database_id)`
- WHEN Maks's `claim --apply` re-reads every relevant comment page
- THEN Maks receives an invariant collision result rather than acquired

#### Scenario: Sona ignores an untrusted marker and a transitive loser

- GIVEN an external commenter posts a valid-looking marker on a later comment page
- AND accepted claim A owns paths `x` and `y`, losing claim B owns `y` and `z`
- WHEN Sona plans path `z`
- THEN the external marker has no scheduling effect
- AND B does not block Sona through its losing overlap with A

#### Scenario: Sona supplies an invalid path or inactive issue

- GIVEN Sona's manifest has a glob, absolute path, dot segment, closed issue, or issue without WIP
- WHEN Sona runs `plan` or `claim`
- THEN the conveyor fails before publishing a marker

> _Technical Note — sources: `scripts/backlog.ts:4` owns command parsing and report output;
> `scripts/backlog-conveyor.ts:102` validates external data; `scripts/backlog-conveyor.ts:493`
> paginates GitHub comments. This change extends those boundaries without changing the
> Phase 1 report schema or trusting a provider account._

### Requirement: The conveyor SHALL safely serialize a host-local named heavy resource

The conveyor SHALL expose `lease acquire|release|status` with a restricted resource name,
opaque non-empty holder, and bounded TTL. The lease state SHALL be visible from every local
worktree through the repository's shared Git common directory and SHALL record a version,
resource, holder, acquisition and expiry times, host, and pid. Acquisition SHALL yield one
atomic winner; a live lease from another holder SHALL refuse safely. Expired well-formed
state SHALL be recoverable by a contender under an atomic per-resource operation guard,
while release SHALL be idempotent and SHALL NOT release another holder's live lease. A
surviving operation guard SHALL fail closed rather than be force-deleted. `status` SHALL NOT
create storage. Unknown, malformed, symlinked, or path-escaping state SHALL fail closed
without force deletion.

#### Scenario: Ira acquires a shared heavy resource

- GIVEN two worktrees in one repository have the same shared Git common directory
- WHEN Ira acquires resource `preflight` with a valid holder and TTL
- THEN either worktree's `lease status` reports Ira's live lease
- AND a simultaneous contender has no second winning lease

#### Scenario: Maks finds a foreign live lease

- GIVEN Ira owns an unexpired `preflight` lease
- WHEN Maks runs `lease acquire` for `preflight`
- THEN the conveyor returns an unsafe refusal
- AND Ira's lease remains unchanged

#### Scenario: Sona encounters unsafe lease storage

- GIVEN the candidate lease state is malformed, symlinked, or resolves outside the lease root
- WHEN Sona runs `lease acquire`, `lease release`, or `lease status`
- THEN the conveyor fails closed
- AND it does not delete or overwrite that state

> _Technical Note — sources: `scripts/backlog-conveyor.ts:1` is the validated coordination
> module and `scripts/backlog-conveyor.ts:507` already obtains the absolute shared Git common
> directory. `scripts/backlog.ts:24` is extended with the lease grammar; the state root is
> derived only from that common directory, never from a provider-local configuration._

## Open Issues

- None.

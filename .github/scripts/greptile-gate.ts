#!/usr/bin/env bun
export type ReviewComment = {
  id: number;
  in_reply_to_id?: number | null;
  user: { login: string } | null;
  html_url: string;
  body: string;
};

const PRIORITY_BADGE = /<img\b[^>]*\balt="(P[123])"/;

const priorityOf = (comment: ReviewComment) => comment.body.match(PRIORITY_BADGE)?.[1];

const GREPTILE_LOGIN = "greptile-apps[bot]";

const isGreptile = (comment: ReviewComment) => comment.user?.login === GREPTILE_LOGIN;

export function blockingFindings(
  comments: ReviewComment[],
  resolvedRootIds: ReadonlySet<number> = new Set(),
): ReviewComment[] {
  const answered = new Set(
    comments.filter((c) => c.in_reply_to_id != null && !isGreptile(c)).map((c) => c.in_reply_to_id),
  );
  return comments.filter(
    (c) =>
      c.in_reply_to_id == null &&
      isGreptile(c) &&
      priorityOf(c) !== "P3" &&
      !answered.has(c.id) &&
      !resolvedRootIds.has(c.id),
  );
}

export function failureReport(findings: ReviewComment[]): string {
  const lines = findings.map((f) => {
    const priority = priorityOf(f) ?? "unrecognised priority";
    const title = f.body.match(/\*\*(.+?)\*\*/)?.[1] ?? "(untitled)";
    return `  ${priority} ${title}\n    ${f.html_url}`;
  });
  return [
    `${findings.length} Greptile finding(s) marked P1/P2, or with a priority badge this check does not recognise, have no reply and no resolved thread:`,
    ...lines,
    "Reply to each thread with the fix commit or why it does not apply. A resolved thread also passes, but resolving does not re-run this check: re-run it by hand.",
  ].join("\n");
}

export type GhApi = (args: string[]) => Promise<unknown>;

const ghApi: GhApi = (args) => Bun.$`gh api ${args}`.json();

async function reviewComments(gh: GhApi, repo: string, pr: string): Promise<ReviewComment[]> {
  const pages = (await gh(["--paginate", "--slurp", `repos/${repo}/pulls/${pr}/comments`])) as ReviewComment[][];
  return pages.flat();
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

type ThreadsPage = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { isResolved: boolean; comments: { nodes: { databaseId: number }[] } }[];
        };
      };
    };
  };
};

async function resolvedRootIds(gh: GhApi, repo: string, pr: string): Promise<Set<number>> {
  const [owner, name] = repo.split("/");
  const resolved = new Set<number>();
  let after: string | null = null;
  do {
    const cursor = after === null ? [] : ["-f", `after=${after}`];
    const page = (await gh(["graphql", "-f", `query=${THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `pr=${pr}`, ...cursor])) as ThreadsPage;
    const threads = page.data.repository.pullRequest.reviewThreads;
    for (const thread of threads.nodes) {
      const root = thread.comments.nodes[0]?.databaseId;
      if (thread.isResolved && root !== undefined) resolved.add(root);
    }
    after = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (after !== null);
  return resolved;
}

export async function fetchReviewState(
  gh: GhApi,
  repo: string,
  pr: string,
): Promise<{ comments: ReviewComment[]; resolved: Set<number> }> {
  const [comments, resolved] = await Promise.all([reviewComments(gh, repo, pr), resolvedRootIds(gh, repo, pr)]);
  return { comments, resolved };
}

export async function runGate(gh: GhApi, repo: string, pr: string, sha: string): Promise<number> {
  const { comments, resolved } = await fetchReviewState(gh, repo, pr);
  const findings = blockingFindings(comments, resolved);
  const state = findings.length > 0 ? "failure" : "success";
  const description =
    findings.length > 0 ? `${findings.length} Greptile P1/P2 finding(s) have no reply` : "Every Greptile P1/P2 finding has a reply or a resolved thread";
  await gh([`repos/${repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", "context=unanswered-findings", "-f", `description=${description}`]);
  if (findings.length > 0) {
    console.error(failureReport(findings));
    return 1;
  }
  console.error(`No unanswered Greptile P1/P2 findings among ${comments.length} review comment(s) on #${pr}.`);
  return 0;
}

if (import.meta.main) {
  const repo = process.env.REPO;
  const pr = process.env.PR_NUMBER;
  const sha = process.env.HEAD_SHA;
  if (!repo || !pr || !sha) {
    console.error("usage: REPO=<owner/name> PR_NUMBER=<n> HEAD_SHA=<sha> bun .github/scripts/greptile-gate.ts");
    process.exit(2);
  }
  process.exit(await runGate(ghApi, repo, pr, sha));
}

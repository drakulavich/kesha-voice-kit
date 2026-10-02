import { describe, expect, test } from "bun:test";
import {
  blockingFindings,
  failureReport,
  fetchReviewState,
  runGate,
  type GhApi,
  type ReviewComment,
} from "../../.github/scripts/greptile-gate";
import recorded from "../fixtures/greptile/review-comments.json";

const COMMENTS = recorded as ReviewComment[];
const UNANSWERED_P2 = 4111349883;
const UNANSWERED_P1 = 4055136594;
const ANSWERED_P1 = 4131549953;

const byId = (id: number) => {
  const comment = COMMENTS.find((c) => c.id === id);
  if (!comment) throw new Error(`fixture has no comment ${id}`);
  return comment;
};
const ids = (findings: ReviewComment[]) => findings.map((f) => f.id);
const replyTo = (root: number, login: string, id = 1): ReviewComment => ({
  id,
  in_reply_to_id: root,
  user: { login },
  html_url: `https://github.com/drakulavich/kesha-voice-kit/pull/1#discussion_r${id}`,
  body: "Fixed in abc123.",
});

describe("blockingFindings", () => {
  test("fails the recorded P1 and P2 roots that nobody answered", () => {
    expect(ids(blockingFindings(COMMENTS)).sort()).toEqual([UNANSWERED_P1, UNANSWERED_P2].sort());
  });

  test("a P1 with a reply passes", () => {
    expect(ids(blockingFindings([byId(ANSWERED_P1), ...COMMENTS.filter((c) => c.in_reply_to_id === ANSWERED_P1)]))).toEqual([]);
  });

  test("a resolved thread passes without a reply", () => {
    expect(ids(blockingFindings(COMMENTS, new Set([UNANSWERED_P2, UNANSWERED_P1])))).toEqual([]);
  });

  test("an unanswered P3 does not block", () => {
    const p2 = byId(UNANSWERED_P2);
    const p3 = { ...p2, body: p2.body.replace('alt="P2"', 'alt="P3"').replace("p2.svg", "p3.svg") };

    expect(ids(blockingFindings([p3]))).toEqual([]);
  });

  test("an unanswered finding whose priority markup is unrecognised blocks", () => {
    const p2 = byId(UNANSWERED_P2);
    const restyled = { ...p2, body: p2.body.replace(/<a href="#"><img [^>]*><\/a>/, '<span data-priority="P2"></span>') };

    expect(ids(blockingFindings([restyled]))).toEqual([UNANSWERED_P2]);
    expect(failureReport([restyled])).toContain("unrecognised priority Test misses same-size replacements");
  });

  test("an answered finding with unrecognised priority markup passes", () => {
    const p1 = byId(ANSWERED_P1);
    const restyled = { ...p1, body: p1.body.replace(/<a href="#"><img [^>]*><\/a>/, "") };

    expect(ids(blockingFindings([restyled, ...COMMENTS.filter((c) => c.in_reply_to_id === ANSWERED_P1)]))).toEqual([]);
  });

  test("Greptile answering its own finding does not count as a reply", () => {
    expect(ids(blockingFindings([byId(UNANSWERED_P1), replyTo(UNANSWERED_P1, "greptile-apps[bot]")]))).toEqual([
      UNANSWERED_P1,
    ]);
  });

  test("a reply from a login that merely contains greptile answers the finding", () => {
    expect(ids(blockingFindings([byId(UNANSWERED_P1), replyTo(UNANSWERED_P1, "notgreptile")]))).toEqual([]);
  });

  test("a reply to another thread does not answer this one", () => {
    expect(ids(blockingFindings([byId(UNANSWERED_P1), replyTo(UNANSWERED_P2, "drakulavich")]))).toEqual([
      UNANSWERED_P1,
    ]);
  });

  test("a P1 badge in someone else's root comment is not a Greptile finding", () => {
    const quoted = { ...byId(UNANSWERED_P1), id: 7, user: { login: "drakulavich" } };

    expect(ids(blockingFindings([quoted]))).toEqual([]);
  });
});

describe("failureReport", () => {
  test("names each finding's priority, title and link", () => {
    const report = failureReport(blockingFindings(COMMENTS));

    expect(report).toContain(`P2 Test misses same-size replacement`);
    expect(report).toContain(byId(UNANSWERED_P2).html_url);
    expect(report).toContain(byId(UNANSWERED_P1).html_url);
  });
});

describe("fetchReviewState", () => {
  const thread = (root: number, isResolved: boolean) => ({ isResolved, comments: { nodes: [{ databaseId: root }] } });
  const threadsPage = (nodes: unknown[], endCursor: string | null) => ({
    data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } } } },
  });
  let graphqlCalls = 0;
  const fakeGh: GhApi = async (args) => {
    if (args[0] !== "graphql") return [COMMENTS.slice(0, 4), COMMENTS.slice(4)];
    if (++graphqlCalls > 2) throw new Error("asked for a third GraphQL page of two");
    return args.includes("after=page-2")
      ? threadsPage([thread(UNANSWERED_P2, true)], null)
      : threadsPage([thread(UNANSWERED_P1, false)], "page-2");
  };

  test("reads every REST page and a resolved thread from the second GraphQL page", async () => {
    const { comments, resolved } = await fetchReviewState(fakeGh, "drakulavich/kesha-voice-kit", "1");

    expect(comments).toHaveLength(COMMENTS.length);
    expect(ids(blockingFindings(comments, resolved))).toEqual([UNANSWERED_P1]);
  });
});

describe("runGate (#1361)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const threadsPage = (nodes: unknown[]) => ({
    data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } },
  });
  function fakeGh(initial: ReviewComment[]) {
    const pr = { comments: initial };
    const statuses: Record<string, string>[] = [];
    const gh: GhApi = async (args) => {
      if (args[0] === "graphql") return threadsPage([]);
      if (args[0] === `repos/drakulavich/kesha-voice-kit/statuses/${SHA}`) {
        const fields = Object.fromEntries(args.filter((a) => a.includes("=")).map((a) => a.split(/=(.*)/s).slice(0, 2)));
        statuses.push(fields);
        return {};
      }
      return [pr.comments];
    };
    return { gh, statuses, pr };
  }

  test("an unanswered finding sets the unanswered-findings status on the head commit to failure", async () => {
    const { gh, statuses } = fakeGh(COMMENTS);
    expect(await runGate(gh, "drakulavich/kesha-voice-kit", "1", SHA)).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ context: "unanswered-findings", state: "failure" });
  });

  test("once every finding is answered, the next run turns the same status from failure to success", async () => {
    const { gh, statuses, pr } = fakeGh(COMMENTS);
    expect(await runGate(gh, "drakulavich/kesha-voice-kit", "1", SHA)).toBe(1);
    pr.comments = [...COMMENTS, replyTo(UNANSWERED_P1, "drakulavich", 1), replyTo(UNANSWERED_P2, "drakulavich", 2)];
    expect(await runGate(gh, "drakulavich/kesha-voice-kit", "1", SHA)).toBe(0);
    expect(statuses.map((s) => `${s.context} ${s.state}`)).toEqual([
      "unanswered-findings pending",
      "unanswered-findings failure",
      "unanswered-findings pending",
      "unanswered-findings success",
    ]);
  });
});

describe("runGate when the review state can't be read (#1361)", () => {
  test("a run that fails before it decides leaves the status pending, never an earlier success", async () => {
    const SHA = "0123456789abcdef0123456789abcdef01234567";
    const statuses: string[] = [`unanswered-findings success`];
    const gh: GhApi = async (args) => {
      if (args[0] === `repos/drakulavich/kesha-voice-kit/statuses/${SHA}`) {
        const field = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
        statuses.push(`${field("context")} ${field("state")}`);
        return {};
      }
      throw new Error("HTTP 502 from api.github.com");
    };
    await expect(runGate(gh, "drakulavich/kesha-voice-kit", "1", SHA)).rejects.toThrow(/502/);
    expect(statuses.at(-1)).toBe("unanswered-findings pending");
  });
});

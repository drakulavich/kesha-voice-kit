import { describe, expect, test } from "bun:test";
import {
  blockingFindings,
  failureReport,
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

  test("Greptile answering its own finding does not count as a reply", () => {
    expect(ids(blockingFindings([byId(UNANSWERED_P1), replyTo(UNANSWERED_P1, "greptile-apps[bot]")]))).toEqual([
      UNANSWERED_P1,
    ]);
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

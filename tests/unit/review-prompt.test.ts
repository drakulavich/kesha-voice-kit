import { describe, expect, test } from "bun:test";
import { buildReviewPrompt } from "../../scripts/review-prompt";

const target = { pr: "1077", head: "a".repeat(40), branch: "feat/x", base: "main", claim: "the guard is pinned" };

describe("the review prompt", () => {
  test("carries the claim and the full head SHA", () => {
    const prompt = buildReviewPrompt(target);
    expect(prompt).toContain(target.claim);
    expect(prompt).toContain(target.head);
    expect(prompt).toContain("#1077");
  });

  // Each of these exists because a review round found what the previous round was never asked (#1077).
  test("sweeps beyond the claim, so the claim cannot narrow the review", () => {
    const prompt = buildReviewPrompt(target);
    expect(prompt).toContain("Second-order");
    expect(prompt).toContain("neutralise it");
    expect(prompt).toContain("name the CI lane that executes it");
    expect(prompt).toContain("Completeness");
    expect(prompt).toContain("re-points a pin at broken output");
  });

  test("asks for an explicit `none` rather than an omission", () => {
    // An omitted item and an examined-but-clean item read identically otherwise.
    expect(buildReviewPrompt(target)).toContain("Report `none` per item rather than omitting it");
  });

  test("demands the mutation be run, not reasoned about", () => {
    const prompt = buildReviewPrompt(target);
    expect(prompt).toContain("Do not settle it by reading");
    expect(prompt).toContain("restore the file");
  });

  test("refuses an empty claim", () => {
    expect(() => buildReviewPrompt({ ...target, claim: "   " })).toThrow("a claim is required");
  });
});

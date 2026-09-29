import { describe, expect, test } from "bun:test";
import { buildPrompt, claimFrom, commentBody, diffRange, reviewerCommand, reviewText } from "../../scripts/review";

const head = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "fedcba9876543210fedcba9876543210fedcba98";
const target = { pr: 1280, head, base: "main", baseSha, branch: "check/review-launcher-1280" };

describe("claimFrom", () => {
  test("refuses a missing or blank claim", () => {
    expect(() => claimFrom([])).toThrow("needs a claim");
    expect(() => claimFrom(["  ", "\n"])).toThrow("needs a claim");
  });

  test("joins unquoted words into one claim", () => {
    expect(claimFrom(["  the", "guard fires  "])).toBe("the guard fires");
  });
});

describe("buildPrompt", () => {
  const prompt = buildPrompt({ ...target, claim: "an empty claim exits 2" });

  test("names the claim to prove or refute", () => {
    expect(prompt).toContain("Prove or refute this claim, and say which assertion fires if it is wrong:\nan empty claim exits 2");
  });

  test("scopes the review to the full head SHA against the PR's base commit", () => {
    expect(prompt).toContain(`pull request #1280 at head ${head}`);
    expect(prompt).toContain(`git diff ${baseSha}...${head}`);
    expect(prompt).not.toContain("origin/");
  });

  test("carries the rubric and ends on a verdict", () => {
    for (const axis of ["correctness", "readability", "architecture", "security", "performance"]) expect(prompt).toContain(axis);
    expect(prompt).toContain("Critical, Required, Optional, Nit or FYI");
    expect(prompt).toContain("`Verdict: Approve` or `Verdict: Request changes`");
  });

  test("refuses a head that is not a full SHA", () => {
    expect(() => buildPrompt({ ...target, head: head.slice(0, 8), claim: "x" })).toThrow("full 40-hex");
  });
});

describe("diffRange", () => {
  test("spans the PR's base commit to its head", () => {
    expect(diffRange(baseSha, head)).toBe(`${baseSha}...${head}`);
  });

  test("refuses a base that is not a full SHA, such as a branch name", () => {
    expect(() => diffRange("origin/main", head)).toThrow("full 40-hex");
  });
});

describe("commentBody", () => {
  test("heads the review with the full head SHA and the claim", () => {
    const body = commentBody({ pr: 1280, head, claim: "x holds", reviewer: "codex", review: "Verdict: Approve\n" });
    expect(body.split("\n")[0]).toBe(`### Adversarial review of #1280 at ${head}`);
    expect(body).toContain("Claim: x holds");
    expect(body).toContain("Reviewer: `codex`");
    expect(body.trimEnd().endsWith("Verdict: Approve")).toBe(true);
  });

  test("refuses a head that is not a full SHA", () => {
    expect(() => commentBody({ pr: 1, head: "abc", claim: "x", reviewer: "r", review: "r" })).toThrow("full 40-hex");
  });
});

describe("reviewerCommand", () => {
  test("defaults to a read-only Codex run reading the prompt from stdin", () => {
    const { argv, binary } = reviewerCommand({}, "/tmp/last.md");
    expect(binary).toBe("codex");
    expect(argv.join(" ")).toContain("--sandbox read-only");
    expect(argv.join(" ")).toContain("--model gpt-6-luna");
    expect(argv.join(" ")).toContain("-o /tmp/last.md");
    expect(argv.at(-1)).toBe("-");
  });

  test("runs KESHA_REVIEWER through the shell", () => {
    expect(reviewerCommand({ KESHA_REVIEWER: " ./stub.sh --canned " }, "/tmp/last.md")).toEqual({
      label: "./stub.sh --canned",
      argv: ["sh", "-c", "./stub.sh --canned"],
      binary: "./stub.sh",
    });
  });
});

describe("reviewText", () => {
  const read = (path: string) => (path === "/tmp/last.md" ? "Verdict: Approve\n" : "");

  test("takes Codex's review from its last-message file, not its stdout", () => {
    expect(reviewText(reviewerCommand({}, "/tmp/last.md"), "progress noise\n", read)).toBe("Verdict: Approve\n");
  });

  test("takes KESHA_REVIEWER's review from its stdout", () => {
    expect(reviewText(reviewerCommand({ KESHA_REVIEWER: "cat" }, "/tmp/last.md"), "Verdict: Approve\n", read)).toBe("Verdict: Approve\n");
  });

  test("treats a missing last-message file as an empty review", () => {
    expect(reviewText(reviewerCommand({}, "/tmp/absent.md"), "progress noise\n", () => { throw new Error("ENOENT"); })).toBe("");
  });
});

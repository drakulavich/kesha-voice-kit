#!/usr/bin/env bun

export type ReviewTarget = { pr: string; head: string; branch: string; base: string; claim: string };

/// The claim focuses the review; the sweep stops it narrowing to only what was asked. Three PRs
/// reviewed on 2026-08-18 needed 2–4 rounds each, and every later round found what a *different
/// question* would have surfaced first — not what a more careful reading would have (#1077).
const SWEEP = [
  "Second-order: for each finding, name what fixing it the obvious way would open. Then check whether this diff's own fixes already did that to an earlier finding — every blocker in one PR's second round was a seam its first round's fix created.",
  "Guards, at full depth: for every guard this diff adds, run BOTH mutations. Delete it, and separately neutralise it while leaving its shape in place — keep the query and drop the refusal, keep the pattern and flip the branch it feeds. Report which assertion fires for each. A guard whose test only catches deletion is unpinned against the mutation that actually happens.",
  "Reach: for every test this diff adds or changes, name the CI lane that executes it. A test compiled everywhere and run nowhere has already shipped twice here.",
  "Recurring classes in this repository, each of which has recurred: a closing keyword naming the wrong issue; a consumer-facing document left stale while the spec was updated; an assertion re-pointed at broken output rather than the change being wrong; a fix that recreates its defect one level up; a new branch that swallows an unrelated failure.",
  "Completeness: end with what you did NOT examine and what you would need in order to. If that list is empty, say so explicitly — an unstated gap reads identically to no gap.",
];

export function buildReviewPrompt(target: ReviewTarget): string {
  if (!target.claim.trim()) throw new Error("a claim is required — a generic review finds generic things");
  return [
    `Adversarial review of pull request #${target.pr} at head ${target.head} (branch ${target.branch} vs ${target.base}).`,
    "",
    "Prove or refute this claim, and say which assertion fires if it is wrong:",
    target.claim,
    "",
    "Where a claim can be settled by running something, run it: mutate the code, execute the test, report the failure, restore the file. Do not settle it by reading.",
    "If you still agree with the claim after examining it, say so plainly — agreement and non-examination look identical otherwise.",
    "",
    "Then, regardless of that claim, sweep for the following. Report `none` per item rather than omitting it.",
    "",
    ...SWEEP.map((item, index) => `${index + 1}. ${item}`),
    "",
    "If the diff touches tests, state whether any existing assertion was changed, deleted or renamed, and whether each change is justified or re-points a pin at broken output.",
    "",
    "Output findings with severity P1/P2/P3.",
  ].join("\n");
}

function usage(message: string): never {
  console.error(`${message}\nusage: bun scripts/review-prompt.ts <pr> <head> <branch> <base> <claim>`);
  process.exit(2);
}

if (import.meta.main) {
  const [pr, head, branch, base, claim] = process.argv.slice(2);
  if (!pr || !head || !branch || !base || claim === undefined) usage("missing argument");
  try {
    console.log(buildReviewPrompt({ pr, head, branch, base, claim }));
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
}

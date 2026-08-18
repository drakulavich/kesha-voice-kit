#!/usr/bin/env bun

/// Decides whether a published tag belongs to the post-engine-release follow-up.
/// `release: published` also fires for `-cli` markers and prereleases, which the
/// follow-up script rejects — one red run per CLI publish unless they skip here.
export function ownsTag(tag: string): boolean {
  return /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag);
}

export type FollowupRefs = { branch: string; openHeads: string[]; remoteHeads: string[] };

/// Refuses while any other follow-up exists, returning the reason or null to proceed.
/// Every follow-up leads the CLI from main's current baseline, so two of them —
/// for different engine tags — otherwise compute and apply the same next version.
/// A branch exists before its pull request does, so both lists are consulted.
export function refuseConcurrentFollowup(refs: FollowupRefs): string | null {
  const prefix = "automation/post-release-";
  const others = new Set<string>();
  for (const head of [...refs.openHeads, ...refs.remoteHeads]) {
    const name = head.startsWith("refs/heads/") ? head.slice("refs/heads/".length) : head;
    if (name.startsWith(prefix) && name !== refs.branch) others.add(name);
  }
  if (others.size === 0) return null;
  return `another post-release follow-up exists (${[...others].sort().join(", ")}); land it before leading the CLI again`;
}

export type GuardEnv = { TAG_NAME?: string; BRANCH?: string; OPEN_HEADS?: string; REMOTE_HEADS?: string };
export type GuardDecision = { skip: true } | { skip: false } | { refuse: string };

function refs(value: string | undefined): string[] {
  return (value ?? "").split("\n").map((line) => line.trim().split(/\s+/).pop() ?? "").filter((line) => line.length > 0);
}

/// The whole decision, so a test pins the branch taken rather than only the predicates.
export function decideFollowup(env: GuardEnv): GuardDecision {
  const tag = env.TAG_NAME;
  if (!tag) return { refuse: "TAG_NAME is required" };
  if (!ownsTag(tag)) return { skip: true };
  const branch = env.BRANCH;
  if (!branch) return { refuse: "BRANCH is required" };
  const refusal = refuseConcurrentFollowup({
    branch,
    openHeads: refs(env.OPEN_HEADS),
    remoteHeads: refs(env.REMOTE_HEADS),
  });
  return refusal ? { refuse: refusal } : { skip: false };
}

if (import.meta.main) {
  const decision = decideFollowup({
    TAG_NAME: process.env.TAG_NAME,
    BRANCH: process.env.BRANCH,
    OPEN_HEADS: process.env.OPEN_HEADS,
    REMOTE_HEADS: process.env.REMOTE_HEADS,
  });
  if ("refuse" in decision) {
    console.error(`::error::${decision.refuse}`);
    process.exit(1);
  }
  console.log(`skip=${decision.skip}`);
}

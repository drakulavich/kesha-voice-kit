import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireLease,
  claim,
  encodeClaimMarker,
  evaluateCollisionPlan,
  evaluateLeaseOperation,
  leaseDirectory,
  leaseRoot,
  loadClaims,
  loadCollisionWorktrees,
  loadPullRequestFiles,
  plan,
  parseClaimManifest,
  releaseLease,
  statusLease,
  type Runner,
} from "../../scripts/backlog-conveyor";
import { parseClaimMarker } from "../../scripts/backlog-coordination";

const now = new Date("2026-08-15T12:00:00.000Z");
const manifest = (overrides: Record<string, unknown> = {}) =>
  parseClaimManifest({
    version: 1,
    issue: 1034,
    holder: "lane-a",
    paths: ["scripts/backlog.ts"],
    ttlSeconds: 600,
    ...overrides,
  });
const claimRecord = (
  issue: number,
  holder: string,
  paths: string[],
  createdAt: string,
  id: number,
  expiresAt = "2026-08-15T12:10:00.000Z",
) => ({
  issue,
  state: "OPEN",
  labels: ["WIP"],
  authorAssociation: "MEMBER",
  createdAt,
  id,
  marker: {
    version: 1 as const,
    action: "claim" as const,
    manifest: { version: 1 as const, issue, holder, paths, ttlSeconds: 600 },
    expiresAt,
  },
  releasedAt: null,
  releasedId: null,
});

describe("backlog collision coordination", () => {
  test("plans claims, pull requests, and worktrees while excluding self and prefix lookalikes", () => {
    const result = evaluateCollisionPlan(
      manifest({ paths: ["scripts"] }),
      {
        claims: [
          claimRecord(
            1033,
            "lane-b",
            ["scripts/backlog-conveyor.ts"],
            "2026-08-15T11:00:00.000Z",
            1,
          ),
        ],
        pullRequests: [
          {
            number: 1041,
            closingIssueNumbers: [1033],
            files: ["scripts/backlog.ts"],
          },
          {
            number: 1042,
            closingIssueNumbers: [1034],
            files: ["scripts/backlog.ts"],
          },
        ],
        worktrees: [
          { branch: "feat/issue-1033", files: ["scripts/backlog.ts"] },
          { branch: "feat/issue-1034", files: ["scripts/backlog.ts"] },
        ],
      },
      now,
    );
    expect(result.edges.map((edge) => edge.source)).toEqual([
      "claim",
      "pull-request",
      "worktree",
    ]);
    expect(result.self.map((edge) => edge.source)).toEqual([
      "pull-request",
      "worktree",
    ]);
    expect(
      evaluateCollisionPlan(
        manifest(),
        {
          claims: [
            claimRecord(
              1033,
              "lane-b",
              ["scripts/backlog.tsx"],
              "2026-08-15T11:00:00.000Z",
              1,
            ),
          ],
          pullRequests: [],
          worktrees: [],
        },
        now,
      ).edges,
    ).toEqual([]);
  });

  test("expires old claims, retains an accepted canonical re-claim, and prevents phantom locks", () => {
    const result = evaluateCollisionPlan(
      manifest({ paths: ["z"] }),
      {
        claims: [
          claimRecord(
            1031,
            "lane-a",
            ["x", "y"],
            "2026-08-15T11:00:00.000Z",
            1,
          ),
          claimRecord(
            1032,
            "lane-b",
            ["y", "z"],
            "2026-08-15T11:01:00.000Z",
            2,
          ),
          claimRecord(
            1034,
            "lane-a",
            ["z"],
            "2026-08-15T11:02:00.000Z",
            3,
            "2026-08-15T11:03:00.000Z",
          ),
        ],
        pullRequests: [],
        worktrees: [],
      },
      now,
    );
    expect(result.edges).toEqual([]);
    expect(result.rejectedClaimIds).toEqual([2]);
    expect(result.idempotent).toBe(false);
  });

  test("permanently rejects an earlier loser after its historical winner expires", () => {
    const winner = claimRecord(
      1033,
      "lane-a",
      ["scripts/backlog.ts"],
      "2026-08-15T11:00:00.000Z",
      1,
      "2026-08-15T12:01:00.000Z",
    );
    const loser = claimRecord(
      1034,
      "lane-b",
      ["scripts/backlog.ts"],
      "2026-08-15T11:01:00.000Z",
      2,
      "2026-08-15T12:10:00.000Z",
    );
    const result = evaluateCollisionPlan(
      manifest({ issue: 1035 }),
      { claims: [winner, loser], pullRequests: [], worktrees: [] },
      new Date("2026-08-15T12:02:00.000Z"),
    );
    expect(result.edges).toEqual([]);
    expect(result.rejectedClaimIds).toEqual([2]);
  });

  test("uses database ids when a winner, contender, and release share one timestamp", () => {
    const timestamp = "2026-08-15T11:00:00.000Z";
    const winner = {
      ...claimRecord(1033, "lane-a", ["scripts/backlog.ts"], timestamp, 1),
      releasedAt: timestamp,
      releasedId: 3,
    };
    const loser = claimRecord(
      1034,
      "lane-b",
      ["scripts/backlog.ts"],
      timestamp,
      2,
    );
    const result = evaluateCollisionPlan(
      manifest({ issue: 1035 }),
      { claims: [winner, loser], pullRequests: [], worktrees: [] },
      now,
    );
    expect(result.edges).toEqual([]);
    expect(result.rejectedClaimIds).toEqual([2]);
  });

  test("treats an observed release as inactive even when it is newer than command start", () => {
    const released = {
      ...claimRecord(
        1033,
        "lane-a",
        ["scripts/backlog.ts"],
        "2026-08-15T11:00:00.000Z",
        1,
      ),
      releasedAt: "2026-08-15T12:01:00.000Z",
      releasedId: 2,
    };
    const result = evaluateCollisionPlan(
      manifest({ issue: 1034 }),
      { claims: [released], pullRequests: [], worktrees: [] },
      now,
    );
    expect(result.edges).toEqual([]);
  });

  test("paginates trusted markers, ignores external markers, and honors a trusted release", async () => {
    const marker = claimRecord(
      1033,
      "lane-b",
      ["scripts/backlog.ts"],
      "2026-08-15T11:00:00.000Z",
      101,
    ).marker;
    const release = { ...marker, action: "release" as const, expiresAt: null };
    const runner: Runner = {
      async run(argv) {
        const target = argv[2] ?? "";
        const page = Number(
          new URL(`https://example.test/${target}`).searchParams.get("page") ??
            "1",
        );
        if (target.includes("/1032/"))
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              page === 1
                ? Array.from({ length: 100 }, (_, index) => ({
                    id: index + 1,
                    created_at: "2026-08-15T10:00:00.000Z",
                    body: index === 99 ? encodeClaimMarker(marker) : "ordinary",
                    author_association: "NONE",
                  }))
                : [],
            ),
          };
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            page === 1
              ? Array.from({ length: 100 }, (_, index) => ({
                  id: 101 + index,
                  created_at: "2026-08-15T11:00:00.000Z",
                  body: index === 0 ? encodeClaimMarker(marker) : "ordinary",
                  author_association: "MEMBER",
                }))
              : [
                  {
                    id: 102,
                    created_at: "2026-08-15T11:01:00.000Z",
                    body: encodeClaimMarker(release),
                    author_association: "COLLABORATOR",
                  },
                ],
          ),
        };
      },
    };
    const claims = await loadClaims(
      runner,
      { owner: "o", name: "r" },
      [
        { number: 1032, state: "OPEN", labels: ["WIP"] },
        { number: 1033, state: "OPEN", labels: ["WIP"] },
      ],
      now,
    );
    expect(claims).toMatchObject([
      { id: 101, releasedAt: "2026-08-15T11:01:00.000Z", releasedId: 102 },
    ]);
    expect(
      evaluateCollisionPlan(
        manifest(),
        {
          claims,
          pullRequests: [],
          worktrees: [],
        },
        now,
      ).edges,
    ).toEqual([]);
  });

  test("paginates pull request files and includes committed-only worktree changes", async () => {
    const runner: Runner = {
      async run(argv) {
        if (argv[0] === "git" && argv[1] === "worktree")
          return {
            exitCode: 0,
            stderr: "",
            stdout:
              "worktree /repo/.worktrees/issue-1033\nHEAD deadbeef\nbranch refs/heads/feat/issue-1033\n",
          };
        if (argv.includes("diff"))
          return { exitCode: 0, stderr: "", stdout: "scripts/backlog.ts\n" };
        if (argv.includes("status"))
          return { exitCode: 0, stderr: "", stdout: "" };
        const target = argv[2] ?? "";
        const page = Number(
          new URL(`https://example.test/${target}`).searchParams.get("page") ??
            "1",
        );
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            page === 1
              ? Array.from({ length: 100 }, (_, index) => ({
                  filename: `docs/${index}.md`,
                }))
              : [{ filename: "scripts/backlog.ts" }],
          ),
        };
      },
    };
    await expect(
      loadPullRequestFiles(runner, { owner: "o", name: "r" }, 1040),
    ).resolves.toContain("scripts/backlog.ts");
    await expect(loadCollisionWorktrees(runner)).resolves.toEqual([
      { branch: "feat/issue-1033", files: ["scripts/backlog.ts"] },
    ]);
  });

  test("collects changed paths from a detached worktree as a conservative collision", async () => {
    const runner: Runner = {
      async run(argv) {
        if (argv[0] === "git" && argv[1] === "worktree")
          return {
            exitCode: 0,
            stderr: "",
            stdout: "worktree /repo/detached\nHEAD deadbeef\ndetached\n",
          };
        if (argv.includes("diff"))
          return { exitCode: 0, stderr: "", stdout: "scripts/backlog.ts\n" };
        return { exitCode: 0, stderr: "", stdout: "?? notes.txt\0" };
      },
    };
    await expect(loadCollisionWorktrees(runner)).resolves.toEqual([
      { branch: null, files: ["notes.txt", "scripts/backlog.ts"] },
    ]);
  });

  test("compensates a losing claim so it cannot resurrect after its winner expires", async () => {
    let reads = 0;
    const posts: string[] = [];
    const theirs = claimRecord(
      1033,
      "lane-b",
      ["scripts/backlog.ts"],
      "2026-08-15T11:00:00.000Z",
      1,
      "2026-08-15T12:01:00.000Z",
    ).marker;
    const runner: Runner = {
      async run(argv) {
        if (argv[0] === "gh" && argv[1] === "repo")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              nameWithOwner: "o/r",
              defaultBranchRef: { name: "main" },
            }),
          };
        if (argv[0] === "gh" && argv[1] === "issue") {
          reads += 1;
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              { number: 1033, state: "OPEN", labels: [{ name: "WIP" }] },
              { number: 1034, state: "OPEN", labels: [{ name: "WIP" }] },
            ]),
          };
        }
        if (argv[0] === "gh" && argv[1] === "pr")
          return { exitCode: 0, stderr: "", stdout: "[]" };
        if (argv[0] === "git" && argv[1] === "worktree")
          return {
            exitCode: 0,
            stderr: "",
            stdout: "worktree /repo\nHEAD deadbeef\nbare\n",
          };
        if (argv.includes("diff") || argv.includes("status"))
          return { exitCode: 0, stderr: "", stdout: "" };
        if (argv[0] === "gh" && argv[1] === "api" && argv[3] === "--method") {
          posts.push(argv.find((part) => part.startsWith("body="))!.slice(5));
          return { exitCode: 0, stderr: "", stdout: "{}" };
        }
        const target = argv[2] ?? "";
        if (target.includes("/comments"))
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              target.includes("/1033/")
                ? reads > 1
                  ? [
                      {
                        id: 1,
                        created_at: "2026-08-15T11:00:00.000Z",
                        body: encodeClaimMarker(theirs),
                        author_association: "MEMBER",
                      },
                    ]
                  : []
                : posts.map((body, index) => ({
                    id: 100 + index,
                    created_at: `2026-08-15T11:0${index + 2}:00.000Z`,
                    body,
                    author_association: "MEMBER",
                  })),
            ),
          };
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      },
    };
    await expect(claim(runner, manifest(), true, now)).resolves.toMatchObject({
      violations: ["claim lost deterministic collision arbitration"],
    });
    expect(posts).toHaveLength(2);
    expect(parseClaimMarker(posts[1]!)).toMatchObject({ action: "release" });
    await expect(
      plan(runner, manifest(), new Date("2026-08-15T12:02:00.000Z")),
    ).resolves.toMatchObject({ plan: { edges: [] } });
  });

  test("compensates its marker when a post-apply pull request collision appears", async () => {
    let reads = 0;
    const posts: string[] = [];
    const runner: Runner = {
      async run(argv) {
        if (argv[0] === "gh" && argv[1] === "repo")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              nameWithOwner: "o/r",
              defaultBranchRef: { name: "main" },
            }),
          };
        if (argv[0] === "gh" && argv[1] === "issue") {
          reads += 1;
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              { number: 1033, state: "OPEN", labels: [{ name: "WIP" }] },
              { number: 1034, state: "OPEN", labels: [{ name: "WIP" }] },
            ]),
          };
        }
        if (argv[0] === "gh" && argv[1] === "pr")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              reads > 1
                ? [
                    {
                      number: 1040,
                      closingIssuesReferences: [{ number: 1033 }],
                    },
                  ]
                : [],
            ),
          };
        if (argv[0] === "git" && argv[1] === "worktree")
          return {
            exitCode: 0,
            stderr: "",
            stdout: "worktree /repo\nHEAD deadbeef\nbare\n",
          };
        if (argv.includes("diff") || argv.includes("status"))
          return { exitCode: 0, stderr: "", stdout: "" };
        if (argv[0] === "gh" && argv[1] === "api" && argv[3] === "--method") {
          posts.push(argv.find((part) => part.startsWith("body="))!.slice(5));
          return { exitCode: 0, stderr: "", stdout: "{}" };
        }
        const target = argv[2] ?? "";
        if (target.includes("/pulls/1040/files"))
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([{ filename: "scripts/backlog.ts" }]),
          };
        if (target.includes("/comments")) {
          const entries = target.includes("/1034/")
            ? posts.map((body, index) => ({
                id: index + 1,
                created_at: `2026-08-15T11:0${index}:00.000Z`,
                body,
                author_association: "MEMBER",
              }))
            : [];
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(entries) };
        }
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      },
    };
    await expect(claim(runner, manifest(), true, now)).resolves.toMatchObject({
      violations: [
        "claim became colliding after acquisition; marker was released",
      ],
    });
    expect(posts).toHaveLength(2);
    expect(parseClaimMarker(posts[1]!)).toMatchObject({ action: "release" });
  });

  test("fails closed instead of silently truncating collision issue or pull request lists", async () => {
    const repo = {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        nameWithOwner: "o/r",
        defaultBranchRef: { name: "main" },
      }),
    };
    const issueCap: Runner = {
      async run(argv) {
        if (argv[1] === "repo") return repo;
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            Array.from({ length: 1000 }, (_, index) => ({
              number: 2000 + index,
              state: "OPEN",
              labels: [{ name: "WIP" }],
            })),
          ),
        };
      },
    };
    await expect(claim(issueCap, manifest(), false, now)).rejects.toThrow(
      "collision issue list reached limit",
    );
    const pullRequestCap: Runner = {
      async run(argv) {
        if (argv[1] === "repo") return repo;
        if (argv[1] === "issue")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              { number: 1034, state: "OPEN", labels: [{ name: "WIP" }] },
            ]),
          };
        if (argv[1] === "pr")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              Array.from({ length: 1000 }, (_, index) => ({
                number: 2000 + index,
                closingIssuesReferences: [],
              })),
            ),
          };
        if (argv[1] === "api") return { exitCode: 0, stderr: "", stdout: "[]" };
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    await expect(claim(pullRequestCap, manifest(), false, now)).rejects.toThrow(
      "collision pull request list reached limit",
    );
  });
});

async function withLeaseRoot(
  run: (common: string) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "kesha-conveyor-lease-"));
  const common = join(root, "shared.git");
  try {
    mkdirSync(common);
    await run(common);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("backlog resource leases", () => {
  test("serializes holders, preserves own expiry, recovers expiry, and releases idempotently", () =>
    withLeaseRoot((common) => {
      const root = leaseDirectory(common);
      expect(
        acquireLease(
          root,
          { resource: "preflight", holder: "lane-a", ttlSeconds: 60 },
          now,
        ).state,
      ).toBe("acquired");
      const expiresAt = statusLease(root, "preflight", now).lease?.expiresAt;
      expect(
        acquireLease(
          root,
          { resource: "preflight", holder: "lane-a", ttlSeconds: 600 },
          now,
        ),
      ).toMatchObject({ state: "already-owned", lease: { expiresAt } });
      expect(
        acquireLease(
          root,
          { resource: "preflight", holder: "lane-b", ttlSeconds: 60 },
          now,
        ).state,
      ).toBe("refused");
      expect(
        acquireLease(
          root,
          { resource: "preflight", holder: "lane-b", ttlSeconds: 60 },
          new Date("2026-08-15T12:02:00.000Z"),
        ),
      ).toMatchObject({ state: "acquired", recovered: true });
      expect(
        releaseLease(
          root,
          { resource: "preflight", holder: "lane-a" },
          new Date("2026-08-15T12:02:01.000Z"),
        ).state,
      ).toBe("refused");
      expect(
        releaseLease(
          root,
          { resource: "preflight", holder: "lane-b" },
          new Date("2026-08-15T12:02:01.000Z"),
        ).state,
      ).toBe("released");
      expect(
        releaseLease(root, { resource: "preflight", holder: "lane-b" }, now)
          .state,
      ).toBe("absent");
    }));

  test("uses holder-aware dry-run decisions and a shared common directory", async () =>
    withLeaseRoot(async (common) => {
      const root = leaseDirectory(common);
      const lease = {
        version: 1 as const,
        resource: "preflight",
        holder: "lane-a",
        acquiredAt: "2026-08-15T12:00:00.000Z",
        expiresAt: "2026-08-15T12:01:00.000Z",
        host: "host",
        pid: 1,
      };
      expect(
        evaluateLeaseOperation(
          "acquire",
          { resource: "preflight", holder: "lane-b" },
          { state: "held", lease },
        ).refusals,
      ).toEqual(["resource lease is held by another holder"]);
      expect(
        evaluateLeaseOperation(
          "acquire",
          { resource: "preflight", holder: "lane-b" },
          { state: "absent", lease: null },
        ).safeActions,
      ).toEqual([{ kind: "acquire-lease", resource: "preflight" }]);
      expect(
        evaluateLeaseOperation(
          "acquire",
          { resource: "preflight", holder: "lane-b" },
          { state: "refused", lease },
        ).refusals,
      ).toEqual([
        "resource lease is held by another holder or operation is busy",
      ]);
      expect(
        evaluateLeaseOperation(
          "release",
          { resource: "preflight", holder: "lane-a" },
          { state: "refused", lease },
        ).refusals,
      ).toEqual([
        "resource lease is held by another holder or operation is busy",
      ]);
      expect(
        evaluateLeaseOperation(
          "acquire",
          { resource: "preflight", holder: "lane-a" },
          { state: "acquired", lease },
        ).findings,
      ).toEqual(["acquired"]);
      expect(
        evaluateLeaseOperation(
          "release",
          { resource: "preflight", holder: "lane-a" },
          { state: "released", lease },
        ).findings,
      ).toEqual(["released"]);
      const runner: Runner = {
        async run() {
          return { exitCode: 0, stderr: "", stdout: `${common}\n` };
        },
      };
      await expect(
        Promise.all([leaseRoot(runner), leaseRoot(runner)]),
      ).resolves.toEqual([root, root]);
    }));

  test("gives concurrent processes one atomic lease winner", async () =>
    withLeaseRoot(async (common) => {
      const root = leaseDirectory(common);
      const source = new URL(
        "../../scripts/backlog-conveyor.ts",
        import.meta.url,
      ).pathname;
      const code = `import { acquireLease } from ${JSON.stringify(source)}; console.log(acquireLease(${JSON.stringify(root)}, { resource: "preflight", holder: process.argv[1], ttlSeconds: 60 }, new Date("2026-08-15T12:00:00.000Z")).state);`;
      const bun = Bun.which("bun");
      if (!bun) throw new Error("bun executable is unavailable");
      const processes = ["lane-a", "lane-b"].map((holder) =>
        Bun.spawn([bun, "--eval", code, holder], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const output = await Promise.all(
        processes.map(async (process) => ({
          exitCode: await process.exited,
          stdout: (await new Response(process.stdout).text()).trim(),
        })),
      );
      expect(output.map((result) => result.stdout).sort()).toEqual([
        "acquired",
        "refused",
      ]);
    }));

  test("serializes concurrent expired-lease reclaimers", async () =>
    withLeaseRoot(async (common) => {
      const root = leaseDirectory(common);
      acquireLease(
        root,
        { resource: "preflight", holder: "expired-owner", ttlSeconds: 1 },
        new Date("2026-08-15T10:00:00.000Z"),
      );
      const source = new URL(
        "../../scripts/backlog-conveyor.ts",
        import.meta.url,
      ).pathname;
      const code = `import { acquireLease } from ${JSON.stringify(source)}; console.log(acquireLease(${JSON.stringify(root)}, { resource: "preflight", holder: process.argv[1], ttlSeconds: 60 }, new Date("2026-08-15T12:00:00.000Z")).state);`;
      const bun = Bun.which("bun");
      if (!bun) throw new Error("bun executable is unavailable");
      const processes = ["lane-a", "lane-b"].map((holder) =>
        Bun.spawn([bun, "--eval", code, holder], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const output = await Promise.all(
        processes.map(async (process) => ({
          exitCode: await process.exited,
          stdout: (await new Response(process.stdout).text()).trim(),
        })),
      );
      expect(output.map((result) => result.stdout).sort()).toEqual([
        "acquired",
        "refused",
      ]);
      expect(statusLease(root, "preflight", now).lease?.holder).toMatch(
        /lane-[ab]/,
      );
    }));

  test("fails closed for malformed, symlinked, escaping, and guarded state without status mutation", () =>
    withLeaseRoot((common) => {
      const root = leaseDirectory(common);
      expect(statusLease(root, "preflight", now)).toEqual({
        state: "absent",
        lease: null,
      });
      expect(existsSync(root)).toBe(false);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "preflight.json"), "not-json");
      expect(() => statusLease(root, "preflight", now)).toThrow(
        "malformed lease state",
      );
      rmSync(join(root, "preflight.json"));
      writeFileSync(join(common, "outside"), "outside");
      symlinkSync(join(common, "outside"), join(root, "preflight.json"));
      expect(() =>
        acquireLease(root, { resource: "preflight", holder: "lane-a" }, now),
      ).toThrow("symlink");
      rmSync(join(root, "preflight.json"));
      writeFileSync(
        join(root, ".preflight.lock"),
        JSON.stringify({ version: 1, resource: "preflight" }),
      );
      expect(() => statusLease(root, "preflight", now)).toThrow(
        "already in progress",
      );
      rmSync(join(root, ".preflight.lock"));
      expect(() =>
        acquireLease(root, { resource: "../escape", holder: "lane-a" }, now),
      ).toThrow("resource");
      expect(() =>
        statusLease(join(common, "missing"), "../escape", now),
      ).toThrow("resource");
      writeFileSync(
        join(root, "preflight.json"),
        JSON.stringify({
          version: 1,
          resource: "preflight",
          holder: "lane-a",
          acquiredAt: "2026-08-15T12:01:00.000Z",
          expiresAt: "2026-08-15T12:00:00.000Z",
          host: "host",
          pid: 1,
        }),
      );
      expect(() => statusLease(root, "preflight", now)).toThrow(
        "invalid lease duration",
      );
      writeFileSync(
        join(root, "preflight.json"),
        JSON.stringify({
          version: 1,
          resource: "preflight",
          holder: "lane-a",
          acquiredAt: "2026-08-15T12:00:00.000Z",
          expiresAt: "2026-08-16T12:00:01.000Z",
          host: "host",
          pid: 1,
        }),
      );
      expect(() => statusLease(root, "preflight", now)).toThrow(
        "invalid lease duration",
      );
    }));
});

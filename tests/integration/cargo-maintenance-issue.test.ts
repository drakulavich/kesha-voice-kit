import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";

const SCRIPT = repoPath(".github/scripts/cargo-maintenance-issue.sh");

const GH_STUB = `#!/usr/bin/env bash
case "$1 $2" in
  "issue list") echo "" ;;
  "label list") echo rust ;;
  "issue create")
    while [[ $# -gt 0 ]]; do [[ $1 == --body-file ]] && cp "$2" "$STUB_OUT/body.md"; shift; done ;;
esac
`;

async function openIssue(cargoStub: string, env: Record<string, string> = {}) {
  const work = tempDir("kesha-cargo-maint-");
  const bin = join(work, "bin");
  mkdirSync(bin);
  mkdirSync(join(work, "rust"));
  const stubs: [string, string][] = [["gh", GH_STUB], ["cargo", `#!/usr/bin/env bash\n${cargoStub}\n`]];
  for (const [name, body] of stubs) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const proc = Bun.spawn(["bash", SCRIPT], {
    cwd: work,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REPO: "owner/name",
      REQUESTED_MONTH: "2026-10",
      RUNNER_TEMP: work,
      STUB_OUT: work,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const body = Bun.file(join(work, "body.md"));
  return { exitCode, body: (await body.exists()) ? await body.text() : null };
}

// The workflow runs on ubuntu-latest only; the stubs are bash scripts on PATH.
describe.skipIf(process.platform === "win32")("cargo-maintenance-issue.sh", () => {
  test("puts the outdated table in the issue and keeps cargo's progress chatter out", async () => {
    const { exitCode, body } = await openIssue(
      'echo "    Updating git repository" >&2; printf "Name  Project  Latest\\nrubato  2.0.0  5.0.0\\n"',
    );

    expect(exitCode).toBe(0);
    expect(body).toContain("rubato  2.0.0  5.0.0");
    expect(body).not.toContain("Updating git repository");
  });

  test("a failed report still opens the checklist, carrying the failure output", async () => {
    const { exitCode, body } = await openIssue('echo "error: index unreachable" >&2; exit 101');

    expect(exitCode).toBe(0);
    expect(body).toContain("- [ ] Run `cd rust && cargo update`");
    expect(body).toContain("**failed**");
    expect(body).toContain("error: index unreachable");
  });

  test("a stalled report is cut off and the checklist still opens", async () => {
    const { exitCode, body } = await openIssue("exec sleep 30", { OUTDATED_TIMEOUT_SECONDS: "1" });

    expect(exitCode).toBe(0);
    expect(body).toContain("- [ ] Run `cd rust && cargo update`");
    expect(body).toContain("timed out after 1s");
  }, 15_000);
});

import { describe, expect, test } from "bun:test";
import { createStableTag, parseArgs, type CommandResult, type CommandRunner } from "../../scripts/release-tag";

const target = "a".repeat(40);
const tagObject = "b".repeat(40);
const tag = "v1.30.0";
const notes = "## Release\n\n- safer tagging\n";

const success = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

function fakeRunner(mode: "push" | "api", failPush = false): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    const command = argv.join(" ");
    if (command === "git fetch origin main") return success();
    if (command === "git rev-parse origin/main") return success(`${target}\n`);
    if (command === "git status --porcelain") return success();
    if (command === `gh api repos/drakulavich/kesha-voice-kit/git/ref/tags/${tag}`) {
      const reads = calls.filter((call) => call.join(" ") === command).length;
      return reads === 1
        ? { code: 1, stdout: "", stderr: "HTTP 404: Not Found" }
        : success(JSON.stringify({ ref: `refs/tags/${tag}`, object: { type: "tag", sha: tagObject } }));
    }
    if (command === `git show-ref --verify --quiet refs/tags/${tag}`) return { code: 1, stdout: "", stderr: "" };
    if (command === "git config user.name") return success("Release Maintainer\n");
    if (command === "git config user.email") return success("release@example.com\n");
    if (command.startsWith("git tag -a")) return success();
    if (command === `git push origin refs/tags/${tag}`) return failPush ? { code: 1, stdout: "", stderr: "timeout" } : success();
    if (command === "gh api --method POST repos/drakulavich/kesha-voice-kit/git/tags --input -") return success(JSON.stringify({ sha: tagObject }));
    if (command.startsWith("gh api --method POST repos/drakulavich/kesha-voice-kit/git/refs ")) return success();
    if (command === `gh api repos/drakulavich/kesha-voice-kit/git/tags/${tagObject}`) {
      return success(JSON.stringify({ tag, message: notes, object: { type: "commit", sha: target }, tagger: { name: "Release Maintainer", email: "release@example.com" } }));
    }
    if (command === "gh workflow run build-engine.yml --repo drakulavich/kesha-voice-kit --ref v1.30.0") return success();
    if (command.includes("gh run list") && command.includes("build-engine.yml")) {
      return success(JSON.stringify([{ headSha: target, event: mode === "push" ? "push" : "workflow_dispatch" }]));
    }
    throw new Error(`unexpected command: ${command}`);
  };
  return { runner, calls };
}

describe("release tag helper", () => {
  test("accepts only a stable tag, notes file, and explicit mode", () => {
    expect(parseArgs(["--tag", tag, "--notes", "notes.md"])).toEqual({ tag, notesPath: "notes.md", mode: "push" });
    expect(parseArgs(["--tag", tag, "--notes", "notes.md", "--mode", "api"]).mode).toBe("api");
    expect(() => parseArgs(["--tag", "v1.30.0-beta.1", "--notes", "notes.md"])).toThrow("stable vX.Y.Z");
  });

  test("uses the ordinary annotated git push path and verifies the remote object and workflow", async () => {
    const { runner, calls } = fakeRunner("push");

    await createStableTag({ tag, notesPath: "notes.md", mode: "push" }, notes, runner);

    expect(calls.some((call) => call.join(" ") === `git tag -a ${tag} ${target} --cleanup=verbatim -F notes.md`)).toBe(true);
    expect(calls.some((call) => call.join(" ") === `git push origin refs/tags/${tag}`)).toBe(true);
    expect(calls.some((call) => call.includes("repos/drakulavich/kesha-voice-kit/git/tags"))).toBe(false);
  });

  test("uses the documented two-step GitHub API fallback and explicitly dispatches the build", async () => {
    const { runner, calls } = fakeRunner("api");

    await createStableTag({ tag, notesPath: "notes.md", mode: "api" }, notes, runner);

    expect(calls.some((call) => call.join(" ") === "gh api --method POST repos/drakulavich/kesha-voice-kit/git/tags --input -")).toBe(true);
    expect(calls.some((call) => call.join(" ") === `gh api --method POST repos/drakulavich/kesha-voice-kit/git/refs -f ref=refs/tags/${tag} -f sha=${tagObject}`)).toBe(true);
    expect(calls.some((call) => call.join(" ") === "gh workflow run build-engine.yml --repo drakulavich/kesha-voice-kit --ref v1.30.0")).toBe(true);
  });

  test("does not switch to the API path after an uncertain push failure", async () => {
    const { runner, calls } = fakeRunner("push", true);

    await expect(createStableTag({ tag, notesPath: "notes.md", mode: "push" }, notes, runner)).rejects.toThrow("remote state is uncertain");
    expect(calls.some((call) => call.join(" ") === "gh api --method POST repos/drakulavich/kesha-voice-kit/git/tags --input -")).toBe(false);
  });
});

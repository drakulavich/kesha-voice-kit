import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { REPO_ROOT } from "../helpers/repo";

const HOOK = `${REPO_ROOT}/.claude/hooks/guard-sha-bump.sh`;

const OLD_SHA = "a".repeat(64);
const NEW_SHA = "b".repeat(64);

// Edit payloads never touch disk — the hook reads file_path only to decide whether it guards the file.
async function edit(filePath: string, newString: string): Promise<number> {
  const payload = JSON.stringify({
    tool_name: "Edit",
    tool_input: {
      file_path: filePath,
      old_string: `    sha256: "${OLD_SHA}",`,
      new_string: newString,
    },
  });
  const proc = Bun.spawn(["bash", HOOK], {
    cwd: tmpdir(),
    stdin: new TextEncoder().encode(payload),
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited;
}

const silentSwap = `    sha256: "${NEW_SHA}",`;

describe("guard-sha-bump.sh", () => {
  test("blocks a silent sha swap in the post-split manifest", async () => {
    expect(await edit("rust/src/models/manifest.rs", silentSwap)).toBe(2);
  });

  test("blocks it under an absolute path and in a nested models file", async () => {
    expect(await edit(`${REPO_ROOT}/rust/src/models/manifest.rs`, silentSwap)).toBe(2);
    expect(await edit("rust/src/models/sub/deep.rs", silentSwap)).toBe(2);
  });

  test("still blocks the pre-split path", async () => {
    expect(await edit("rust/src/models.rs", silentSwap)).toBe(2);
  });

  test("ignores engine sources outside the models tree", async () => {
    expect(await edit("rust/src/other.rs", silentSwap)).toBe(0);
  });

  test("allows a swap that carries a justification", async () => {
    expect(
      await edit("rust/src/models/manifest.rs", `    // bumped: upstream re-export\n${silentSwap}`),
    ).toBe(0);
  });
});

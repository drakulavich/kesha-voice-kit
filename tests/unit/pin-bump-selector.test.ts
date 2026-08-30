import { describe, expect, test } from "bun:test";
import { readRepoFile } from "../helpers/repo";

// CLAUDE.md, docs/architecture.md, docs/runbooks/rust-gotchas.md and .claude/skills/verify-pin-bump/SKILL.md
// all document `cargo test models::manifest`. A cargo filter that matches nothing exits 0, so renaming the
// module out from under those four docs would silently restore the exit-0-on-a-broken-pin hole (#950).
describe("the documented pin-bump selector still matches tests", () => {
  test("manifest.rs declares the module models::manifest's tests live in", () => {
    expect(readRepoFile("rust/src/models/manifest.rs")).toContain("mod manifest_tests");
  });
});

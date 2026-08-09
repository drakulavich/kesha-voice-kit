import { describe, expect, test } from "bun:test";
import { composeEngineReleaseNotes } from "../../.github/scripts/engine-release-notes.mjs";
import { parseRepoYaml, readRepoFile } from "../helpers/repo";

const BUILD_ENGINE = ".github/workflows/build-engine.yml";

describe("composeEngineReleaseNotes", () => {
  test("authored notes lead, and the verification section follows them", () => {
    const body = composeEngineReleaseNotes("v1.25.0", "## Highlights\n\n- faster decode\n");

    expect(body.startsWith("## Highlights")).toBe(true);
    expect(body).toContain("- faster decode");
    expect(body.indexOf("### Verify release assets")).toBeGreaterThan(body.indexOf("- faster decode"));
  });

  // A lightweight tag hands git the *commit* message; the release keeps its verification
  // section and loses only the notes it never had (#815).
  test("a tag with no annotation still gets the verification section", () => {
    const body = composeEngineReleaseNotes("v1.25.0", undefined);

    expect(body.startsWith("### Verify release assets")).toBe(true);
    expect(body).not.toContain("undefined");
  });

  test("whitespace-only notes are not notes", () => {
    expect(composeEngineReleaseNotes("v1.25.0", "  \n\n ")).toBe(composeEngineReleaseNotes("v1.25.0", undefined));
  });

  test("the verification steps name the tag being released", () => {
    const body = composeEngineReleaseNotes("v1.25.0", undefined);

    expect(body).toContain("gh release download v1.25.0");
    expect(body).toContain("build-engine.yml@refs/tags/v1.25.0");
    expect(body).toContain("kesha-voice-kit-v1.25.0.spdx.json");
  });

  // The heredoc this replaced fenced a bash block; a body that lost the fence renders as prose.
  test("the verification commands stay inside a fenced block", () => {
    const body = composeEngineReleaseNotes("v1.25.0", undefined);

    expect(body).toContain("```bash");
    expect(body.match(/```/g)?.length).toBe(2);
  });
});

describe("the engine release lane", () => {
  // `%(contents)` on a lightweight tag returns the commit message, so reading it unguarded
  // publishes an internal commit subject as the release body (#815).
  test("the notes step delegates to the gated script instead of reading the tag inline", () => {
    const steps = parseRepoYaml(BUILD_ENGINE).jobs.release.steps;
    const notes = steps.find((s: { name?: string }) => s.name?.includes("release notes"));

    expect(notes.run).toContain("engine-release-notes.mjs");
    expect(notes.run).not.toContain("%(contents)");
    expect(notes.run).not.toContain("${{");
  });

  // Comment lines are prose about the hazard, not a step that publishes one, so they are
  // stripped the way forbidLinuxPackaging strips them.
  test("no step in the workflow reads tag contents directly", () => {
    const code = readRepoFile(BUILD_ENGINE)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    expect(code).not.toContain("%(contents)");
  });
});

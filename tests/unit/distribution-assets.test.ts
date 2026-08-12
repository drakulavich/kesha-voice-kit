import { describe, expect, test } from "bun:test";
import { readRepoFile } from "../helpers/repo";

// `completions` and `man` are imported by src/cli/{completions,manpage}.ts, so a payload that
// omits them fails at module load, not at file read — every path has to stage them (#914).
describe("every distribution payload stages the bundled assets", () => {
  test.each([
    ["packaging/homebrew/Formula/kesha-voice-kit.rb", "completions"],
    ["packaging/homebrew/Formula/kesha-voice-kit.rb", '"man"'],
    ["Dockerfile", "COPY completions ./completions"],
    ["Dockerfile", "COPY man ./man"],
    ["flake.nix", "./completions"],
    ["flake.nix", "./man"],
    ["flake.nix", "cp -r bin src completions man"],
  ])("%s stages %s", (path, token) => {
    expect(readRepoFile(path)).toContain(token);
  });

  test.each(["completions/", "man/"])("the npm package publishes %s", (entry) => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { files?: string[] };

    expect(pkg.files ?? []).toContain(entry);
  });
});

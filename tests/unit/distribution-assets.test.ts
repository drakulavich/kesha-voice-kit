import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { REPO_ROOT, readRepoFile } from "../helpers/repo";

// A payload that stages `src/` without a root file it imports fails at module load (#914, #1429).
function importedRootAssets(): string[] {
  const sources = [
    ...readdirSync(join(REPO_ROOT, "src"), { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".ts") && !p.includes("__tests__"))
      .map((p) => join("src", p)),
    ...readdirSync(join(REPO_ROOT, "bin")).map((p) => join("bin", p)),
  ];
  const assets = new Set<string>();
  for (const file of sources) {
    for (const [, spec] of readRepoFile(file).matchAll(/(?:from|import\()\s*"(\.\.?\/[^"]+)"/g)) {
      const top = relative(REPO_ROOT, join(REPO_ROOT, dirname(file), spec!)).split(/[\\/]/)[0]!;
      if (top !== "src" && top !== "bin") assets.add(top);
    }
  }
  return [...assets].sort();
}

const quoted = (line: string) => [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

const PAYLOADS: Record<string, () => string[]> = {
  "packaging/homebrew/Formula/kesha-voice-kit.rb": () =>
    readRepoFile("packaging/homebrew/Formula/kesha-voice-kit.rb")
      .split("\n")
      .filter((l) => l.trim().startsWith("libexec.install"))
      .flatMap(quoted),
  Dockerfile: () =>
    readRepoFile("Dockerfile")
      .split("\n")
      .filter((l) => l.startsWith("COPY "))
      .flatMap((l) => l.split(/\s+/).slice(1, -1)),
  "flake.nix fileset": () => [...readRepoFile("flake.nix").matchAll(/^\s+\.\/([\w.-]+)$/gm)].map((m) => m[1]!),
  "flake.nix installPhase": () =>
    readRepoFile("flake.nix")
      .match(/cp -r ((?:[^\n]*\\\n)*[^\n]*)\$out\/lib\/kesha\//)![1]!
      .split(/[\s\\]+/)
      .filter(Boolean),
  "package.json#files": () =>
    (JSON.parse(readRepoFile("package.json")) as { files: string[] }).files.map((f) => f.replace(/\/$/, "")),
};

describe("every distribution payload stages the root assets the CLI imports", () => {
  const assets = importedRootAssets();

  test("the import scan finds the known assets", () => {
    expect(assets).toEqual(expect.arrayContaining(["completions", "man", "model-plan.json", "package.json"]));
  });

  test.each(Object.keys(PAYLOADS).flatMap((payload) => assets.map((asset) => [payload, asset])))(
    "%s stages %s",
    (payload, asset) => {
      expect(PAYLOADS[payload]!()).toContain(asset);
    },
  );
});

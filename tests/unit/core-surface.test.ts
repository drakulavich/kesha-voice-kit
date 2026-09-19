import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRepoFile, REPO_ROOT, repoPath } from "../helpers/repo";
import { tempDir } from "../helpers/temp-dir";

/**
 * Pins `./core`'s exported types to the list `openspec/specs/programmatic-api/spec.md`
 * requires (#1206): the list below is extracted from the spec text, never copied by hand,
 * so the two cannot drift apart unnoticed.
 */
function specExportedTypeNames(): string[] {
  const spec = readRepoFile("openspec/specs/programmatic-api/spec.md");
  const sentence = /SHALL export the following TypeScript types:\s*([\s\S]*?)\./.exec(spec);
  if (!sentence) throw new Error("spec no longer has a 'SHALL export the following TypeScript types' sentence");
  return [...sentence[1]!.matchAll(/`([A-Za-z0-9_]+)`/g)].map((m) => m[1]!);
}

function missingExportNames(tscOutput: string): string[] {
  return [...tscOutput.matchAll(/has no exported member '([A-Za-z0-9_]+)'/g)].map((m) => m[1]!);
}

/** The probe must resolve through the published `./core` entry point, not an implementation path, or it keeps passing after `package.json#exports["./core"]` regresses. */
function coreEntryPath(): string {
  const pkg = JSON.parse(readRepoFile("package.json"));
  const entry = pkg.exports?.["./core"];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error('package.json exports["./core"] is missing or not a non-empty string');
  }
  return entry;
}

function writeProbeProject(dir: string, typeNames: string[]): string {
  const importList = typeNames.join(",\n  ");
  const fields = typeNames.map((name) => `  ${name}: ${name};`).join("\n");
  // A raw Windows path's backslashes read back as string escapes; forward slashes resolve on every platform.
  const modulePath = repoPath(coreEntryPath()).replaceAll("\\", "/");
  writeFileSync(
    join(dir, "probe.ts"),
    `import type {\n  ${importList},\n} from "${modulePath}";\n\nexport type Probe = {\n${fields}\n};\n`,
  );
  const tsconfigPath = join(dir, "tsconfig.json");
  writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          typeRoots: [repoPath("node_modules/@types"), repoPath("node_modules")],
          types: ["bun-types"],
          strict: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["probe.ts"],
      },
      null,
      2,
    ),
  );
  return tsconfigPath;
}

describe("core surface", () => {
  const typeNames = specExportedTypeNames();

  it("lists at least 9 names including VadMode (guard against a regex miss)", () => {
    expect(typeNames.length).toBeGreaterThanOrEqual(9);
    expect(typeNames).toContain("VadMode");
  });

  it("./core exports every type the spec lists", async () => {
    const dir = tempDir("core-surface-");
    const tsconfigPath = writeProbeProject(dir, typeNames);

    const proc = Bun.spawn(["bun", "x", "tsc", "--noEmit", "-p", tsconfigPath], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const missing = missingExportNames(`${stdout}${stderr}`);
    const message =
      missing.length > 0
        ? `core surface lacks ${missing.join(", ")} (spec lists ${missing.length === 1 ? "it" : "them"})\n${stdout}${stderr}`
        : `probe did not typecheck\n${stdout}${stderr}`;
    expect(exitCode, message).toBe(0);
  });
});

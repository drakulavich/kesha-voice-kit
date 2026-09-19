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

function writeProbeProject(dir: string, typeNames: string[]): string {
  const importList = typeNames.join(",\n  ");
  const fields = typeNames.map((name) => `  ${name}: ${name};`).join("\n");
  writeFileSync(
    join(dir, "probe.ts"),
    `import type {\n  ${importList},\n} from "${repoPath("src/lib")}";\n\nexport type Probe = {\n${fields}\n};\n`,
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

    expect(exitCode, `core surface lacks VadMode (spec lists it)\n${stdout}${stderr}`).toBe(0);
  }, 5000);
});

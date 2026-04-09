# CLI Help with citty — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite CLI with citty for structured help, subcommands, multi-file transcription, and `--json` output.

**Architecture:** Replace hand-rolled arg parsing in `src/cli.ts` with citty's `defineCommand` + `runMain`. Main command handles transcription with variadic files via `args._`. Install is a subcommand. `--json` flag controls output format. Export command definitions for testability.

**Tech Stack:** citty (CLI framework), Bun, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-09-cli-help-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/cli.ts` | Rewrite: citty command definitions + runMain |
| `src/__tests__/cli.test.ts` | Create: CLI parsing and output format tests |
| `package.json` | Modify: add citty dependency |
| `README.md` | Modify: update license section |

---

### Task 1: Add citty dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install citty**

```bash
bun add citty
```

- [ ] **Step 2: Verify installation**

```bash
bun run -e "import { defineCommand } from 'citty'; console.log('ok')"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add citty CLI framework dependency"
```

---

### Task 2: Rewrite CLI with citty

**Files:**
- Modify: `src/cli.ts` (full rewrite)

- [ ] **Step 1: Write the failing test for help output**

Create `src/__tests__/cli.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { renderUsage } from "citty";
import { mainCommand, installCommand } from "../cli";

describe("CLI help", () => {
  test("main help contains usage and commands", async () => {
    const usage = await renderUsage(mainCommand);
    expect(usage).toContain("Usage:");
    expect(usage).toContain("install");
  });

  test("install help contains backend options", async () => {
    const usage = await renderUsage(installCommand);
    expect(usage).toContain("--coreml");
    expect(usage).toContain("--onnx");
    expect(usage).toContain("--no-cache");
  });

  test("main help contains --json flag", async () => {
    const usage = await renderUsage(mainCommand);
    expect(usage).toContain("--json");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/cli.test.ts`
Expected: FAIL — `mainCommand` and `installCommand` are not exported from `../cli`

- [ ] **Step 3: Rewrite `src/cli.ts` with citty**

Replace the entire contents of `src/cli.ts` with:

```typescript
#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";
import { transcribe } from "./lib";
import { downloadModel } from "./onnx-install";
import { downloadCoreML } from "./coreml-install";
import { isMacArm64 } from "./coreml";
import { log } from "./log";

const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();

export const installCommand = defineCommand({
  meta: {
    name: "install",
    description: "Download speech-to-text models",
  },
  args: {
    coreml: {
      type: "boolean",
      description: "Force CoreML backend (macOS arm64)",
      default: false,
    },
    onnx: {
      type: "boolean",
      description: "Force ONNX backend",
      default: false,
    },
    noCache: {
      type: "boolean",
      description: "Re-download even if cached",
      default: false,
    },
  },
  async run({ args }) {
    try {
      if (args.coreml) {
        if (!isMacArm64()) {
          log.error("CoreML backend is only available on macOS Apple Silicon.");
          process.exit(1);
        }
        await downloadCoreML(args.noCache);
      } else if (args.onnx) {
        await downloadModel(args.noCache);
      } else if (isMacArm64()) {
        await downloadCoreML(args.noCache);
      } else {
        await downloadModel(args.noCache);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(message);
      process.exit(1);
    }
  },
});

export const mainCommand = defineCommand({
  meta: {
    name: "parakeet",
    version: pkg.version,
    description: "Fast local speech-to-text. 25 languages. CoreML on Apple Silicon, ONNX on CPU.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output results as JSON",
      default: false,
    },
  },
  subCommands: {
    install: installCommand,
  },
  async run({ args }) {
    const files = args._ as string[];

    if (files.length === 0) {
      log.info("No audio files specified. Run `parakeet --help` for usage.");
      process.exit(1);
    }

    let hasError = false;
    const results: Array<{ file: string; text: string }> = [];

    for (let i = 0; i < files.length; i++) {
      try {
        const text = await transcribe(files[i]);

        if (args.json) {
          results.push({ file: files[i], text });
        } else {
          if (files.length > 1) {
            if (i > 0) process.stdout.write("\n");
            process.stdout.write(`=== ${files[i]} ===\n`);
          }
          if (text) process.stdout.write(text + "\n");
        }
      } catch (err: unknown) {
        hasError = true;
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${files[i]}: ${message}`);
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    }

    if (hasError) process.exit(1);
  },
});

runMain(mainCommand);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/cli.test.ts`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Run full test suite and type check**

Run: `bun test && bunx tsc --noEmit`
Expected: All tests pass, no type errors

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/__tests__/cli.test.ts
git commit -m "feat: rewrite CLI with citty for structured help and multi-file support"
```

---

### Task 3: Add output format tests

**Files:**
- Modify: `src/__tests__/cli.test.ts`

- [ ] **Step 1: Write tests for text and JSON output formatting**

Add to `src/__tests__/cli.test.ts`:

```typescript
import { formatTextOutput, formatJsonOutput } from "../cli";

describe("output formatting", () => {
  test("single file text: no header", () => {
    const output = formatTextOutput([{ file: "a.ogg", text: "Hello" }]);
    expect(output).toBe("Hello\n");
  });

  test("multiple files text: headers per file", () => {
    const output = formatTextOutput([
      { file: "a.ogg", text: "Hello" },
      { file: "b.mp3", text: "World" },
    ]);
    expect(output).toBe("=== a.ogg ===\nHello\n\n=== b.mp3 ===\nWorld\n");
  });

  test("JSON output: always array, pretty-printed", () => {
    const output = formatJsonOutput([{ file: "a.ogg", text: "Hello" }]);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([{ file: "a.ogg", text: "Hello" }]);
    expect(output).toContain("\n"); // pretty-printed, not compact
  });

  test("JSON output: multiple files", () => {
    const output = formatJsonOutput([
      { file: "a.ogg", text: "Hello" },
      { file: "b.mp3", text: "World" },
    ]);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].file).toBe("a.ogg");
    expect(parsed[1].file).toBe("b.mp3");
  });

  test("JSON output: empty array when no results", () => {
    const output = formatJsonOutput([]);
    expect(JSON.parse(output)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/cli.test.ts`
Expected: FAIL — `formatTextOutput` and `formatJsonOutput` are not exported from `../cli`

- [ ] **Step 3: Extract and export formatting functions**

Add to `src/cli.ts`, before `runMain(mainCommand)`:

```typescript
export type TranscribeResult = { file: string; text: string };

export function formatTextOutput(results: TranscribeResult[]): string {
  if (results.length === 1) {
    return results[0].text + "\n";
  }
  return results
    .map((r, i) => (i > 0 ? "\n" : "") + `=== ${r.file} ===\n${r.text}\n`)
    .join("");
}

export function formatJsonOutput(results: TranscribeResult[]): string {
  return JSON.stringify(results, null, 2) + "\n";
}
```

Then update the `run` handler in `mainCommand` to use them — replace the inline formatting logic:

```typescript
  async run({ args }) {
    const files = args._ as string[];

    if (files.length === 0) {
      log.info("No audio files specified. Run `parakeet --help` for usage.");
      process.exit(1);
    }

    let hasError = false;
    const results: TranscribeResult[] = [];

    for (const file of files) {
      try {
        const text = await transcribe(file);
        results.push({ file, text });
      } catch (err: unknown) {
        hasError = true;
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${file}: ${message}`);
      }
    }

    if (args.json) {
      process.stdout.write(formatJsonOutput(results));
    } else {
      process.stdout.write(formatTextOutput(results));
    }

    if (hasError) process.exit(1);
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/cli.test.ts`
Expected: PASS — all 8 tests green

- [ ] **Step 5: Run full test suite and type check**

Run: `bun test && bunx tsc --noEmit`
Expected: All tests pass, no type errors

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/__tests__/cli.test.ts
git commit -m "feat: add --json output and extract formatting functions"
```

---

### Task 4: Update README license section

**Files:**
- Modify: `README.md:118-120`

- [ ] **Step 1: Update the license section**

Replace lines 118-120 of `README.md`:

From:
```markdown
## License

MIT
```

To:
```markdown
## License

Made with 💛🩵 Published under MIT License.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update license section in README"
```

---

### Task 5: Manual verification

- [ ] **Step 1: Test help output**

```bash
bun src/cli.ts --help
bun src/cli.ts install --help
bun src/cli.ts --version
```

Verify output matches the spec's target output section.

- [ ] **Step 2: Test multi-file transcription (if backend installed)**

```bash
bun src/cli.ts fixtures/benchmark/01-ne-nuzhno-slat-soobshcheniya.ogg fixtures/benchmark/02-prover-vse-svoi-konfigi.ogg
```

Expected: headers per file, transcripts underneath.

- [ ] **Step 3: Test JSON output (if backend installed)**

```bash
bun src/cli.ts --json fixtures/benchmark/01-ne-nuzhno-slat-soobshcheniya.ogg
```

Expected: pretty-printed JSON array with one element.

- [ ] **Step 4: Run full verification**

```bash
bun test && bunx tsc --noEmit
```

Expected: All tests pass, no type errors.

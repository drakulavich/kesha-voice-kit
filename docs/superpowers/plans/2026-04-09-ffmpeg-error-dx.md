# Improved ffmpeg Error Messages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic "ffmpeg not found in PATH" error with an OS-aware message that suggests the correct install command.

**Architecture:** Add a `getFfmpegInstallHint()` helper to `src/audio.ts` that checks `process.platform` and probes for package managers via `Bun.which()`. The existing `assertFfmpegExists()` uses the hint in its error message. No new files or dependencies.

**Tech Stack:** TypeScript, Bun (`Bun.which`), picocolors (via existing `src/log.ts` — not used directly; error is thrown, not logged)

**Spec:** `docs/superpowers/specs/2026-04-09-ffmpeg-error-dx-design.md`

---

### Task 1: Add `getFfmpegInstallHint()` with tests

**Files:**
- Modify: `src/audio.ts:64-70`
- Create: `src/__tests__/audio.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/audio.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { getFfmpegInstallHint } from "../audio";

describe("getFfmpegInstallHint", () => {
  test("returns a non-empty string", () => {
    const hint = getFfmpegInstallHint();
    expect(hint).toBeTruthy();
    expect(typeof hint).toBe("string");
  });

  test("contains install keyword", () => {
    const hint = getFfmpegInstallHint();
    expect(hint).toMatch(/install|ffmpeg\.org/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/audio.test.ts`
Expected: FAIL — `getFfmpegInstallHint` is not exported from `../audio`

- [ ] **Step 3: Implement `getFfmpegInstallHint()`**

In `src/audio.ts`, add this exported function before `assertFfmpegExists`:

```typescript
export function getFfmpegInstallHint(): string {
  const platform = process.platform;

  if (platform === "darwin") {
    if (Bun.which("brew")) return "  brew install ffmpeg";
    if (Bun.which("port")) return "  sudo port install ffmpeg";
  }

  if (platform === "linux") {
    if (Bun.which("apt")) return "  sudo apt install ffmpeg";
    if (Bun.which("dnf")) return "  sudo dnf install ffmpeg-free";
    if (Bun.which("pacman")) return "  sudo pacman -S ffmpeg";
  }

  if (platform === "win32") {
    if (Bun.which("choco")) return "  choco install ffmpeg";
    if (Bun.which("scoop")) return "  scoop install ffmpeg";
    if (Bun.which("winget")) return "  winget install ffmpeg";
  }

  return "  https://ffmpeg.org/download.html";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/audio.test.ts`
Expected: PASS — both tests green

- [ ] **Step 5: Commit**

```bash
git add src/audio.ts src/__tests__/audio.test.ts
git commit -m "feat: add getFfmpegInstallHint with OS-aware install suggestions"
```

---

### Task 2: Update `assertFfmpegExists()` to use the hint

**Files:**
- Modify: `src/audio.ts:64-70`

- [ ] **Step 1: Write a failing test for the error message**

Add to `src/__tests__/audio.test.ts`:

```typescript
import { assertFfmpegExists } from "../audio";

describe("assertFfmpegExists", () => {
  test("includes install hint when ffmpeg is missing", () => {
    // Save and override Bun.which to simulate missing ffmpeg
    const originalWhich = Bun.which;
    Bun.which = ((cmd: string) => {
      if (cmd === "ffmpeg") return null;
      return originalWhich(cmd);
    }) as typeof Bun.which;

    // Reset the cached check so assertFfmpegExists re-checks
    resetFfmpegCheck();

    try {
      expect(() => assertFfmpegExists()).toThrow(/Install it:/);
    } finally {
      Bun.which = originalWhich;
      resetFfmpegCheck();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/audio.test.ts`
Expected: FAIL — `assertFfmpegExists` is not exported, `resetFfmpegCheck` does not exist, and the error message doesn't match `/Install it:/`

- [ ] **Step 3: Export `assertFfmpegExists`, add `resetFfmpegCheck`, and update the error message**

In `src/audio.ts`, make these changes:

1. Export `assertFfmpegExists`:

```typescript
export function assertFfmpegExists(): void {
```

2. Add a `resetFfmpegCheck` export for testing:

```typescript
export function resetFfmpegCheck(): void {
  ffmpegChecked = false;
}
```

3. Update the error message inside `assertFfmpegExists`:

```typescript
export function assertFfmpegExists(): void {
  if (ffmpegChecked) return;
  if (!Bun.which("ffmpeg")) {
    const hint = getFfmpegInstallHint();
    throw new Error(
      `ffmpeg is required but not found in PATH.\n\nInstall it:\n${hint}`
    );
  }
  ffmpegChecked = true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/audio.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Run full test suite and type check**

Run: `bun test && bunx tsc --noEmit`
Expected: All tests pass, no type errors

- [ ] **Step 6: Commit**

```bash
git add src/audio.ts src/__tests__/audio.test.ts
git commit -m "feat: show OS-specific ffmpeg install instructions on missing ffmpeg"
```

import { describe, expect, it } from "vitest";
import { parseShebang, resolveKeshaBin } from "../src/lib/kesha-bin";
import type { KeshaBinDeps } from "../src/lib/kesha-bin";

describe("parseShebang", () => {
  it("extracts the interpreter line from a shebang header", () => {
    expect(parseShebang(Buffer.from("#!/usr/bin/env bun\nconsole.log()"))).toBe(
      "/usr/bin/env bun",
    );
    expect(parseShebang(Buffer.from("#!/bin/sh -e\n"))).toBe("/bin/sh -e");
    expect(parseShebang(Buffer.from("#!/bin/sh"))).toBe("/bin/sh");
    expect(parseShebang(Buffer.from("#!/usr/bin/env bun\r\nrest"))).toBe(
      "/usr/bin/env bun",
    );
    expect(parseShebang(Buffer.from("#! /bin/sh \n"))).toBe("/bin/sh");
  });

  it("returns null for binaries and empty files", () => {
    expect(parseShebang(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBeNull();
    expect(parseShebang(Buffer.alloc(0))).toBeNull();
    expect(parseShebang(Buffer.from("#"))).toBeNull();
  });
});

interface FakeFile {
  shebang?: string;
  realpath?: string;
}

function fakeDeps(
  files: Record<string, FakeFile>,
  overrides: KeshaBinDeps = {},
): KeshaBinDeps {
  return {
    interpreterCandidates: [],
    isExecutable: async (path) => path in files,
    readShebang: async (path) => files[path]?.shebang ?? null,
    realpath: async (path) => files[path]?.realpath ?? path,
    ...overrides,
  };
}

describe("resolveKeshaBin", () => {
  it("prefers the explicit preference and trims it", async () => {
    const deps = fakeDeps(
      { "/custom/kesha": {} },
      { candidates: ["/fallback/kesha"] },
    );
    expect(await resolveKeshaBin(" /custom/kesha ", deps)).toEqual({
      command: "/custom/kesha",
      prefixArgs: [],
    });
  });

  it("does not fall back to candidates when the preference is unusable", async () => {
    const deps = fakeDeps(
      { "/fallback/kesha": {} },
      { candidates: ["/fallback/kesha"] },
    );
    expect(await resolveKeshaBin("/missing/kesha", deps)).toBeNull();
  });

  it("returns null when every fallback candidate is non-executable", async () => {
    const deps = fakeDeps({}, { candidates: ["/a/kesha", "/b/kesha"] });
    expect(await resolveKeshaBin(undefined, deps)).toBeNull();
  });

  it("picks the first executable fallback candidate", async () => {
    const deps = fakeDeps(
      { "/second/kesha": {}, "/third/kesha": {} },
      { candidates: ["/first/kesha", "/second/kesha", "/third/kesha"] },
    );
    expect(await resolveKeshaBin(undefined, deps)).toEqual({
      command: "/second/kesha",
      prefixArgs: [],
    });
  });

  it("runs an env-shebang script through a matching interpreter", async () => {
    const deps = fakeDeps(
      {
        "/global/kesha": { realpath: "/pkg/cli.ts" },
        "/pkg/cli.ts": { shebang: "/usr/bin/env bun" },
        "/opt/bin/node": {},
        "/opt/bin/bun": {},
      },
      {
        candidates: ["/global/kesha"],
        interpreterCandidates: ["/opt/bin/node", "/opt/bin/bun"],
      },
    );
    expect(await resolveKeshaBin(undefined, deps)).toEqual({
      command: "/opt/bin/bun",
      prefixArgs: ["/pkg/cli.ts"],
    });
  });

  it("falls back to direct execution when no interpreter matches", async () => {
    const deps = fakeDeps(
      {
        "/global/kesha": { realpath: "/pkg/cli.ts" },
        "/pkg/cli.ts": { shebang: "/usr/bin/env bun" },
        "/opt/bin/node": {},
      },
      {
        candidates: ["/global/kesha"],
        interpreterCandidates: ["/opt/bin/node"],
      },
    );
    expect(await resolveKeshaBin(undefined, deps)).toEqual({
      command: "/global/kesha",
      prefixArgs: [],
    });
  });

  it("reads the shebang from the original path when realpath fails", async () => {
    const deps = fakeDeps(
      {
        "/global/kesha": { shebang: "/usr/bin/env bun" },
        "/opt/bin/bun": {},
      },
      {
        candidates: ["/global/kesha"],
        interpreterCandidates: ["/opt/bin/bun"],
        realpath: async (path) => {
          throw new Error(`ENOENT: ${path}`);
        },
      },
    );
    expect(await resolveKeshaBin(undefined, deps)).toEqual({
      command: "/opt/bin/bun",
      prefixArgs: ["/global/kesha"],
    });
  });

  it("executes non-env shebangs directly", async () => {
    const deps = fakeDeps(
      {
        "/global/kesha": { realpath: "/pkg/kesha.sh" },
        "/pkg/kesha.sh": { shebang: "/bin/sh" },
      },
      { candidates: ["/global/kesha"] },
    );
    expect(await resolveKeshaBin(undefined, deps)).toEqual({
      command: "/global/kesha",
      prefixArgs: [],
    });
  });
});

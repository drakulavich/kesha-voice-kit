import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pactPath, provenancePath, verify } from "../../.github/scripts/record-capability-pacts";
import { tempDir } from "../helpers/temp-dir";

const TARGET = "linux-x64";
const DOCUMENT = '{\n  "protocol": 1\n}\n';
const BINARY_BYTES = "stub engine binary";

describe("record-capability-pacts verify()", () => {
  const startedIn = process.cwd();
  let binary: string;

  beforeEach(() => {
    const dir = tempDir("kesha-pact-verify-");
    process.chdir(dir);
    mkdirSync(join("tests", "fixtures", "capabilities"), { recursive: true });
    binary = join(dir, "kesha-engine");
    writeFileSync(binary, BINARY_BYTES);
    writeFileSync(pactPath(TARGET), DOCUMENT);
    writeFileSync(
      provenancePath(TARGET),
      JSON.stringify({
        engineVersion: "1.2.3",
        assetName: "kesha-engine-linux-x64",
        sha256: createHash("sha256").update(BINARY_BYTES).digest("hex"),
        recordedFrom: "kesha-engine-linux-x64 from release v1.2.3",
      }),
    );
    spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(startedIn);
    mock.restore();
  });

  test("passes when version, binary and document all match the recording", () => {
    expect(() => verify(TARGET, binary, DOCUMENT, "1.2.3")).not.toThrow();
  });

  test("fails when the binary checked is another engine version", () => {
    expect(() => verify(TARGET, binary, DOCUMENT, "1.2.4")).toThrow("exit 1");
  });

  test("fails when the binary hashes differently from the provenance", () => {
    writeFileSync(binary, `${BINARY_BYTES} rebuilt`);
    expect(() => verify(TARGET, binary, DOCUMENT, "1.2.3")).toThrow("exit 1");
  });

  test("fails when the binary's describe differs from the committed pact", () => {
    expect(() => verify(TARGET, binary, '{\n  "protocol": 2\n}\n', "1.2.3")).toThrow("exit 1");
  });
});

describe("record-capability-pacts arguments", () => {
  test("refuses --binary without the version it was released as", () => {
    const run = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "..", ".github", "scripts", "record-capability-pacts.ts"), "--binary", "./missing"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode).toBe(2);
  });

  test("refuses --from-release with a --version it would ignore", () => {
    const run = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "..", ".github", "scripts", "record-capability-pacts.ts"), "--from-release", "--version", "1.2.3"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("drop --version");
  });
});

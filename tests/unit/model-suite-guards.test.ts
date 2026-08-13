import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { engineDependencies, gateIdentifiers, ungatedCases } from "../helpers/suite-guards";
import { readRepoFile, repoPath } from "../helpers/repo";

/**
 * The TS mirror of `rust/tests/model_gate.rs`. Rust enforces its model-tier guards and lists
 * the skips it exempts; this side's guard convention was enforced by nothing, so an unguarded
 * real-engine case reached the fast lane as a timeout instead of a skip (#921).
 *
 * `UNGATED_BY_DESIGN` is the escape hatch, and it is empty on purpose: running ungated is still
 * a sanctioned choice — CLAUDE.md calls the resulting breakage the intended loud signal — but it
 * now has to be written down rather than happen by accident.
 */
const UNGATED_BY_DESIGN: Record<string, string> = {};

const SUITE_DIR = "tests/integration";

function suiteSources(): Array<{ name: string; source: string }> {
  return readdirSync(repoPath(SUITE_DIR))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => ({ name, source: readRepoFile(`${SUITE_DIR}/${name}`) }));
}

const realEngineSuites = suiteSources().filter(({ source }) => engineDependencies(source).length > 0);

describe("integration suites that drive a real engine", () => {
  // Without this the gate below could pass by detecting nothing at all — the failure the Rust
  // side guards with `a_mini_staged_lane_is_distinguishable_from_a_real_one`.
  test("are still recognised, in both guard shapes the convention documents", () => {
    const detected = realEngineSuites.map((s) => s.name);
    expect(detected).toContain("e2e-engine.test.ts");
    expect(detected).toContain("say-e2e.test.ts");
  });

  test("do not include the suites that drive a fake engine", () => {
    const detected = realEngineSuites.map((s) => s.name);
    expect(detected).not.toContain("cli-contracts.test.ts");
    expect(detected).not.toContain("say.test.ts");
  });

  test.each(
    realEngineSuites
      .filter((s) => UNGATED_BY_DESIGN[s.name] === undefined)
      .map(({ name, source }) => [name, source] as const),
  )("%s gates every case it declares", (name, source) => {
    const findings = ungatedCases(source);
    if (findings.length === 0) return;

    const listed = findings.map((f) => `  ${SUITE_DIR}/${name}:${f.line}  ${f.declaration}\n    ${f.reason}`);
    const declared = gateIdentifiers(source);
    throw new Error(
      `${SUITE_DIR}/${name} needs ${engineDependencies(source).join(" and ")}, which the fast CI lane ` +
        `does not have — but these cases run unconditionally:\n${listed.join("\n")}\n\n` +
        `Gate the whole suite with \`describe.skipIf(!<gate>)\`, or each case with \`it.skipIf(!<gate>)\`, ` +
        `where <gate> is a top-level const derived from engineGate()/modelsRequired() ` +
        `(tests/helpers/model-gate.ts) or from the source-built engine plus KOKORO_MODEL/KOKORO_VOICE. ` +
        `${declared.length > 0 ? `This suite already declares ${declared.join(", ")}.` : `This suite declares no such const yet.`} ` +
        `The convention is written up in ${SUITE_DIR}/README.md; if the suite is meant to run ungated, ` +
        `add it to UNGATED_BY_DESIGN in tests/unit/model-suite-guards.test.ts with the reason.`,
    );
  });

  test("carry no stale exemptions", () => {
    for (const [name, reason] of Object.entries(UNGATED_BY_DESIGN)) {
      expect(reason).not.toBe("");
      expect(realEngineSuites.map((s) => s.name)).toContain(name);
    }
  });
});

const GATED_SUITE = `import { describe, test } from "bun:test";
import { engineGate } from "../helpers/model-gate";

const engineGateResult = await engineGate();
const engineInstalled = engineGateResult.installed;

describe.skipIf(!engineInstalled)("suite", () => {
  test("case", () => {});
});
`;

const PER_CASE_SUITE = `import { describe, it } from "bun:test";
import { existsSync } from "fs";

const SPIKE_MODEL = process.env.KOKORO_MODEL ?? "/tmp/kokoro-spike/model.onnx";
const BUILT = "rust/target/release/kesha-engine";
const AVAILABLE = existsSync(SPIKE_MODEL) && existsSync(BUILT);

describe("suite", () => {
  it.skipIf(!AVAILABLE)("case", () => {});
});
`;

describe("engineDependencies", () => {
  test("names the engine a suite reaches for", () => {
    expect(engineDependencies(GATED_SUITE)).toEqual(["a functional installed engine (engineGate)"]);
    expect(engineDependencies(PER_CASE_SUITE)).toEqual([
      "a source-built engine (rust/target/release/kesha-engine)",
    ]);
  });

  test("reads a named import spread over several lines", () => {
    const source = `import {\n  getEngineBinPath,\n  TRANSCRIBE_ITN_FEATURE,\n} from "../../src/engine";\n`;
    expect(engineDependencies(source)).toEqual(["the installed engine binary (getEngineBinPath)"]);
  });

  // Every CLI suite sets KESHA_ENGINE_BIN; most point it at a shell script they wrote themselves.
  test("leaves a suite that stages its own fake engine alone", () => {
    const source = `import { spawn } from "bun";\nconst env = { KESHA_ENGINE_BIN: fakeEngine() };\n`;
    expect(engineDependencies(source)).toEqual([]);
  });
});

describe("gateIdentifiers", () => {
  test("follows a probe through the constant it is stored in", () => {
    expect(gateIdentifiers(GATED_SUITE).sort()).toEqual(["engineGateResult", "engineInstalled"]);
  });
});

describe("ungatedCases", () => {
  test("passes both sanctioned guard shapes", () => {
    expect(ungatedCases(GATED_SUITE)).toEqual([]);
    expect(ungatedCases(PER_CASE_SUITE)).toEqual([]);
  });

  test("reports a case added beside a guarded one", () => {
    const findings = ungatedCases(
      PER_CASE_SUITE.replace('  it.skipIf(!AVAILABLE)("case", () => {});\n', (kept) => `${kept}  it("added later", () => {});\n`),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.declaration).toContain("added later");
    expect(findings[0]!.reason).toContain("neither it nor an enclosing describe");
  });

  test("reports a whole suite whose describe lost its guard", () => {
    const findings = ungatedCases(GATED_SUITE.replace("describe.skipIf(!engineInstalled)", "describe"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.declaration).toContain('test("case"');
  });

  test("rejects a skipIf that gates on something other than the engine", () => {
    const findings = ungatedCases(
      PER_CASE_SUITE.replace("it.skipIf(!AVAILABLE)", 'it.skipIf(process.platform === "win32")'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toContain("no constant derived from a real-engine probe");
  });

  // The `requiredFailure` raisers (#741, #857) exist to break a lane that promised an engine.
  test("leaves a case declared inside a conditional block alone", () => {
    const source = `import { test } from "bun:test";
import { engineGate } from "../helpers/model-gate";

const engineGateResult = await engineGate();
if (engineGateResult.requiredFailure) {
  test("this lane must ship a functional engine (#741)", () => {
    throw new Error(engineGateResult.requiredFailure!);
  });
}
`;
    expect(ungatedCases(source)).toEqual([]);
  });

  test("reads a CRLF checkout the same as an LF one", () => {
    expect(ungatedCases(GATED_SUITE.replace(/\n/g, "\r\n"))).toEqual([]);
    expect(engineDependencies(GATED_SUITE.replace(/\n/g, "\r\n"))).toHaveLength(1);
  });
});

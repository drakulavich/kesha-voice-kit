import { describe, expect, test } from "bun:test";
import { buildGateEvidence } from "../../scripts/gate-evidence";
import { canonicalGateEvidencePayload, digestGateEvidence, parseGateEvidence } from "../../scripts/backlog-conveyor";

const SHA = "693cd6dbbe180a81dd75732ade0160e373ed43d0";
const base = { provider: "grok", headSha: SHA, uri: "https://example.invalid/pr/1#c1" };

describe("gate evidence", () => {
  test("is accepted by the gate's own parser", () => {
    // The point of building it here is that the gate verifies it there; a shape only this file
    // agrees with would pass its own tests and be refused in the one place that matters.
    expect(() => parseGateEvidence(JSON.parse(JSON.stringify(buildGateEvidence(base))))).not.toThrow();
  });

  test("carries the literals the contract fixes, not remembered ones", () => {
    const evidence = buildGateEvidence(base);
    expect(evidence.version).toBe(1);
    expect(evidence.verdict).toBe("APPROVED");
    expect(evidence.headSha).toBe(SHA);
  });

  test("its digest covers the payload, so an edited field invalidates it", () => {
    const evidence = buildGateEvidence(base);
    const { digest: _drop, ...payload } = evidence;
    expect(evidence.digest).toBe(digestGateEvidence(payload));
    // Build the neighbour by construction: `replace(/.$/, "0")` on a SHA already ending in 0
    // is a mutation that never applies, which is exactly what `just mutate` refuses to do (#1075).
    const neighbour = `${SHA.slice(0, 39)}${SHA.endsWith("0") ? "1" : "0"}`;
    expect(neighbour).not.toBe(SHA);
    expect(digestGateEvidence({ ...payload, headSha: neighbour })).not.toBe(evidence.digest);
    expect(canonicalGateEvidencePayload(payload)).toContain(SHA);
  });

  test("refuses an abbreviated SHA, which the gate would bind to nothing", () => {
    expect(() => buildGateEvidence({ ...base, headSha: SHA.slice(0, 8) })).toThrow("40-character");
    expect(() => buildGateEvidence({ ...base, provider: "" })).toThrow("provider");
  });
});

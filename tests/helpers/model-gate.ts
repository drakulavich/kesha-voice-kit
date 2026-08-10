import { engineFunctionalHealth } from "../../src/engine-health";

/** Mirrors the Rust side's `models_required()` — set by the lanes that stage the engine (#741). */
export function modelsRequired(): boolean {
  return process.env.KESHA_REQUIRE_MODEL_TESTS === "1";
}

export interface EngineGate {
  installed: boolean;
  /** Non-null when the lane promised an engine and there isn't one; raise it from a test. */
  requiredFailure: string | null;
}

/**
 * Whether the installed engine can describe itself, for suites that self-skip without one.
 *
 * Returns the fault rather than throwing: a throw during module evaluation exits non-zero but
 * produces no named testcase, so this lane's JUnit → step-summary → Flakiness pipeline would
 * report a green run of nothing anyway.
 */
export async function engineGate(): Promise<EngineGate> {
  const health = await engineFunctionalHealth();
  if (health.status === "ok") return { installed: true, requiredFailure: null };
  if (!modelsRequired()) return { installed: false, requiredFailure: null };

  const detail = "detail" in health ? ` (${health.detail})` : "";
  return {
    installed: false,
    requiredFailure:
      `engine is "${health.status}"${detail} while KESHA_REQUIRE_MODEL_TESTS is set — this ` +
      `lane installs the engine, so skipping the model-dependent suites here would be a ` +
      `green run of nothing (#741).`,
  };
}

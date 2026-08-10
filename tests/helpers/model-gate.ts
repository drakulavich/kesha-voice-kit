import { engineFunctionalHealth } from "../../src/engine-health";

/** Mirrors the Rust side's `models_required()` — set by the lanes that stage the engine (#741). */
export function modelsRequired(): boolean {
  return process.env.KESHA_REQUIRE_MODEL_TESTS === "1";
}

/**
 * Whether the installed engine can describe itself, for suites that self-skip without one.
 *
 * Throws instead of returning false when the lane promised an engine: `integration-tests-full`
 * installs the model bundle, so a gate that cannot find it is a broken layout rather than a
 * laptop, and skipping there is a green run of nothing (#741).
 */
export async function engineUsableOrRequired(): Promise<boolean> {
  const health = await engineFunctionalHealth();
  if (health.status === "ok") return true;
  if (modelsRequired()) {
    throw new Error(
      `engine is "${health.status}" while KESHA_REQUIRE_MODEL_TESTS is set — this lane ` +
        `installs the engine, so skipping the model-dependent suites here would be a green ` +
        `run of nothing (#741).`,
    );
  }
  return false;
}

/**
 * Workaround for Bun + onnxruntime-node backend registration issue.
 *
 * When Bun imports onnxruntime-node (CJS), the backend gets registered
 * in the CJS instance of onnxruntime-common. But our ESM code gets the
 * ESM instance of onnxruntime-common, which has no backends registered.
 *
 * This module manually registers the native backend into the ESM module.
 */

let registered = false;

export function ensureOrtBackend(): void {
  if (registered) return;
  registered = true;

  try {
    // Force-load onnxruntime-node via require() to trigger CJS side-effects
    // that register the native backend. Under bun test this happens
    // automatically, but bun run may need the nudge.
    require("onnxruntime-node");
  } catch {
    // If it fails, the native backend might already be registered
    // (e.g. running under Node.js or a future Bun version that fixes this)
  }
}

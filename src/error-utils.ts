import { KeshaError } from "./engine/events";

/** Human-readable message from an unknown catch value; a coded error renders with its code. */
export function errorMessage(err: unknown): string {
  if (err instanceof KeshaError) return err.render();
  return err instanceof Error ? err.message : String(err);
}

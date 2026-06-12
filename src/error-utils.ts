/** Human-readable message from an unknown catch value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { encode as encodeToon } from "@toon-format/toon";

/**
 * TOON (#138) encoding of an array of transcription results. Same data shape
 * as `formatJsonOutput`; lossless round-trip through `@toon-format/toon`'s
 * `decode()`.
 *
 * Generic so this module stays independent of `TranscribeResult` (defined in
 * `cli.ts`) and doesn't introduce a runtime cycle between `lib.ts` and
 * `cli.ts`. Callers that have the concrete `TranscribeResult[]` type will
 * still get a type-checked call via structural compatibility.
 */
export function formatToonOutput<T extends object>(results: T[]): string {
  return encodeToon(results) + "\n";
}

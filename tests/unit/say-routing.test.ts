import { describe, expect, test } from "bun:test";
import { resolveSayVoice } from "../../src/cli/say";

// resolveSayVoice precedence: --voice > --lang (route by stated language,
// skip detection) > macOS auto-detect > engine default (undefined).
// The --voice and --lang branches return before touching the engine, so these
// are pure and platform-independent for `en`.
describe("resolveSayVoice precedence", () => {
  test("explicit --voice wins over a --lang hint", async () => {
    expect(await resolveSayVoice("ru-vosk-m02", "es", "Hola mundo")).toBe("ru-vosk-m02");
  });

  test("--lang routes to that language's default voice (skips detection)", async () => {
    expect(await resolveSayVoice(undefined, "en", "irrelevant")).toBe("en-am_michael");
    // BCP 47 region/script subtags are normalized away before lookup.
    expect(await resolveSayVoice(undefined, "en-US", "irrelevant")).toBe("en-am_michael");
    expect(await resolveSayVoice(undefined, "EN_us", "irrelevant")).toBe("en-am_michael");
  });

  test("--lang with no mapped voice → undefined (engine default), no re-detection", async () => {
    // French has no male Kokoro voice → unmapped on every platform.
    expect(await resolveSayVoice(undefined, "fr", "Bonjour")).toBeUndefined();
    // Unknown language code → unmapped.
    expect(await resolveSayVoice(undefined, "xx", "whatever")).toBeUndefined();
  });
});

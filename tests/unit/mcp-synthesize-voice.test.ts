import { describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createKeshaMcpServer } from "../../src/mcp/server";
import { DEFAULT_VOICE_ID, pickVoiceForLang } from "../../src/voice-routing";

const skipOnWin32 = process.platform === "win32" ? test.skip : test;

interface SynthesizingEngine {
  binPath: string;
  /** Every argument the stub's last `say` invocation received. */
  sayArgs(): string[];
}

/**
 * A stub engine that answers `detect-text-lang` with `lang` (or fails detection when it is
 * null, the Linux/Windows reality) and records the argv of the `say` it is then handed.
 */
function synthesizingEngine(lang: { code: string; confidence: number } | null): SynthesizingEngine {
  const dir = mkdtempSync(join(tmpdir(), "kesha-mcp-synth-"));
  const binPath = join(dir, "kesha-engine");
  const argvPath = join(dir, "say-argv");
  const detect = lang
    ? `printf '%s\\n' '${JSON.stringify(lang)}'\n  exit 0`
    : `printf '%s\\n' 'detect-text-lang: unsupported on this build' >&2\n  exit 2`;
  writeFileSync(
    binPath,
    `#!/bin/sh
if [ "$1" = "detect-text-lang" ]; then
  ${detect}
fi
if [ "$1" = "say" ]; then
  cat > /dev/null
  : > '${argvPath}'
  out=""
  prev=""
  for a in "$@"; do
    printf '%s\\n' "$a" >> '${argvPath}'
    if [ "$prev" = "--out" ]; then out="$a"; fi
    prev="$a"
  done
  printf 'RIFF' > "$out"
  exit 0
fi
exit 2
`,
  );
  chmodSync(binPath, 0o755);
  return {
    binPath,
    sayArgs: () => readFileSync(argvPath, "utf8").split("\n").filter(Boolean),
  };
}

async function synthesize(engine: SynthesizingEngine, args: Record<string, unknown>) {
  const prev = process.env.KESHA_ENGINE_BIN;
  process.env.KESHA_ENGINE_BIN = engine.binPath;
  try {
    const server = createKeshaMcpServer();
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const res = await client.callTool({ name: "synthesize_speech", arguments: args });
    return { res, voice: (res.structuredContent as { voice: string }).voice };
  } finally {
    if (prev === undefined) delete process.env.KESHA_ENGINE_BIN;
    else process.env.KESHA_ENGINE_BIN = prev;
  }
}

describe("synthesize_speech reports the voice it used (#942)", () => {
  skipOnWin32("voice omitted: reports the auto-routed id, and hands the engine that same id", async () => {
    const engine = synthesizingEngine({ code: "en", confidence: 0.99 });
    const { res, voice } = await synthesize(engine, { text: "Meeting starts now." });

    expect(res.isError).toBeUndefined();
    expect(voice).toBe("en-am_michael");
    expect(engine.sayArgs()).toContain(voice);
  });

  skipOnWin32("voice omitted, Russian text: routes away from the English default", async () => {
    const engine = synthesizingEngine({ code: "ru", confidence: 0.99 });
    const { voice } = await synthesize(engine, { text: "Совещание начинается." });

    // The contract is "the same voice `kesha say` would use", so it is asserted against the
    // routing function rather than a literal — which Russian voice is right depends on the
    // platform, and darwin's AVSpeech Milena is a documented choice, not a defect (CLAUDE.md).
    const routed = pickVoiceForLang("ru", 0.99);
    expect(routed).toBeDefined();
    expect(voice).toBe(routed as string);
    expect(voice).not.toBe(DEFAULT_VOICE_ID);
    expect(engine.sayArgs()).toContain(voice);
  });

  skipOnWin32("detection unavailable: reports the default voice, never a placeholder", async () => {
    const engine = synthesizingEngine(null);
    const { voice } = await synthesize(engine, { text: "Meeting starts now." });

    expect(voice).toBe("en-am_michael");
    expect(engine.sayArgs()).toContain(voice);
  });

  skipOnWin32("explicit voice is echoed back verbatim", async () => {
    const engine = synthesizingEngine({ code: "en", confidence: 0.99 });
    const { voice } = await synthesize(engine, { text: "Привет", voice: "ru-vosk-m02" });

    expect(voice).toBe("ru-vosk-m02");
    expect(engine.sayArgs()).toContain(voice);
  });
});

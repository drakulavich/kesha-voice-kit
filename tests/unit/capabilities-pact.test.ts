/**
 * Consumer side of the capability pact (#798).
 *
 * `Capabilities` is derived entirely at compile time, so an in-process Rust test only ever
 * sees the build running it. Nothing compared the darwin CoreML shape against the
 * Linux/Windows ONNX shape, and nothing checked that the flags the TS side emits are accepted
 * by the target it emits them at — that matrix is observable only from the real binaries,
 * which until now only the model-downloading lanes ever saw.
 *
 * These tests read `tests/fixtures/capabilities/<target>.json` — recordings of
 * `--capabilities-json` from the published binaries — and drive the production seams against
 * them. No engine, no models, no network. `.github/workflows/capability-pact.yml` re-records
 * from the real artifacts and fails on drift, which is what stops a pact from rotting into a
 * false green; it also owns the pinned-version check, which cannot live here because a release
 * PR bumps `keshaEngine.version` before the tag it names exists.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  pactPath,
  provenancePath,
  type PactProvenance,
} from "../../.github/scripts/record-capability-pacts";
import {
  assertItnSupported,
  assertSpeakersSupported,
  buildTranscribeArgs,
  RECORD_LIVE_FEATURE,
  TRANSCRIBE_DIARIZE_FEATURE,
  TRANSCRIBE_ITN_FEATURE,
  TRANSCRIBE_SEGMENTS_FEATURE,
  textLangFailureWarning,
  type EngineCapabilities,
} from "../../src/engine";
import { buildEngineInstallArgs, validateDiarize } from "../../src/engine-install";
import { engineTargetEntries, targetKey } from "../../src/engine-targets";
import { buildSayArgs, type SayOptions } from "../../src/synth";
import { pickVoiceForLang } from "../../src/voice-routing";
import { readRepoFile, repoPath } from "../helpers/repo";

interface PactTarget {
  key: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  backend: "coreml" | "onnx";
  pact: EngineCapabilities;
  provenance: PactProvenance;
}

const unrecorded: string[] = [];
const TARGETS: PactTarget[] = [];
for (const { platform, arch, target } of engineTargetEntries()) {
  const key = targetKey(platform, arch);
  if (!existsSync(repoPath(pactPath(key))) || !existsSync(repoPath(provenancePath(key)))) {
    unrecorded.push(key);
    continue;
  }
  TARGETS.push({
    key,
    platform: platform as NodeJS.Platform,
    arch: arch as NodeJS.Architecture,
    backend: target.backend,
    pact: JSON.parse(readRepoFile(pactPath(key))) as EngineCapabilities,
    provenance: JSON.parse(readRepoFile(provenancePath(key))) as PactProvenance,
  });
}

/**
 * Every engine flag the TS side can emit, and the capabilities that make a target accept it —
 * an empty list means clap defines it on every published build. A flag emitted by one of the
 * argv builders with no row here fails `classifies every flag the TS side can emit`, which is
 * what keeps this table honest as flags are added.
 */
const FLAG_CAPABILITIES: Record<string, string[]> = {
  "--voice": ["tts"],
  "--lang": ["tts"],
  "--out": ["tts"],
  "--rate": ["tts"],
  "--ssml": ["tts"],
  "--format": ["tts"],
  "--bitrate": ["tts"],
  "--sample-rate": ["tts"],
  "--no-expand-abbrev": ["tts.ru_acronym_expansion", "tts.en_acronym_expansion"],
  "--no-cache": [],
  "--tts": ["tts"],
  "--vad": ["vad"],
  "--no-vad": ["vad"],
  "--diarize": [TRANSCRIBE_DIARIZE_FEATURE],
  "--json": [TRANSCRIBE_SEGMENTS_FEATURE],
  "--itn": [TRANSCRIBE_ITN_FEATURE],
  "--speakers": [TRANSCRIBE_DIARIZE_FEATURE],
};

/**
 * Guards that must refuse a flag before it reaches an engine whose pact lacks its capability.
 * `buildSayArgs` guards itself by taking capabilities and dropping the flag; the transcribe
 * and install builders are capability-blind, so their gated flags need an entry here.
 */
const FLAG_GUARDS: Record<string, (caps: EngineCapabilities) => void> = {
  "--diarize": validateDiarize,
  "--speakers": assertSpeakersSupported,
  "--itn": assertItnSupported,
};

/** Maximal option sets, so the builders emit every flag they are capable of emitting. */
const EVERY_SAY_OPTION: SayOptions = {
  text: "hello",
  voice: "en-am_michael",
  lang: "en",
  out: "out.wav",
  rate: 1.5,
  ssml: true,
  format: "ogg-opus",
  bitrate: 32_000,
  sampleRate: 24_000,
  noExpandAbbrev: true,
};
const EVERY_INSTALL_OPTION = { noCache: true, ttsLangs: ["en"], vad: true, diarize: true };

/** A hypothetical engine advertising everything, so a builder emits every flag it can. */
const EVERY_CAPABILITY: EngineCapabilities = {
  protocolVersion: 3,
  backend: "onnx",
  features: Object.values(FLAG_CAPABILITIES).flat(),
};

const flagsIn = (argv: string[]): string[] => argv.filter((arg) => arg.startsWith("--"));

const satisfies = (pact: EngineCapabilities, capabilities: string[]): boolean =>
  capabilities.length === 0 || capabilities.some((c) => pact.features.includes(c));

/** Everything the TS side can put on the wire that no capability check filters first. */
const capabilityBlindFlags = (): string[] => [
  ...flagsIn(buildEngineInstallArgs(EVERY_INSTALL_OPTION)),
  ...flagsIn(buildTranscribeArgs("a.wav", { vad: "on", itn: true, speakers: true }, true)),
  ...flagsIn(buildTranscribeArgs("a.wav", { vad: "off" })),
];

describe("capability pact — recordings", () => {
  it("records a pact for every published engine target", () => {
    expect(unrecorded).toEqual([]);
  });

  it("records every target from the same engine release", () => {
    // Mixed versions would gate one platform's flags against another platform's binary.
    expect([...new Set(TARGETS.map((t) => t.provenance.engineVersion))]).toHaveLength(1);
  });

  for (const { key, backend, pact } of TARGETS) {
    it(`${key} reports the backend src/engine-targets.ts claims it ships`, () => {
      expect(pact.backend).toBe(backend);
    });
  }

  // Point 4 of #798: an in-process test structurally cannot see a bump that lands on one
  // target only, and the wire format the TS parser reads is shared across all of them.
  it("speaks one protocol version across every target", () => {
    expect([...new Set(TARGETS.map((t) => t.pact.protocolVersion))]).toHaveLength(1);
  });
});

describe("capability pact — flags the TS side emits", () => {
  it("classifies every flag the TS side can emit", () => {
    const emitted = new Set([
      ...flagsIn(buildSayArgs(EVERY_SAY_OPTION, EVERY_CAPABILITY)),
      ...capabilityBlindFlags(),
    ]);
    expect([...emitted].filter((flag) => FLAG_CAPABILITIES[flag] === undefined)).toEqual([]);
  });

  for (const { key, pact } of TARGETS) {
    it(`emits no say flag ${key}'s engine would reject`, () => {
      // buildSayArgs takes the target's own capabilities, exactly as say() passes the
      // installed engine's — so this is its drop decision held against the real binary.
      const unsupported = flagsIn(buildSayArgs(EVERY_SAY_OPTION, pact)).filter(
        (flag) => !satisfies(pact, FLAG_CAPABILITIES[flag] ?? []),
      );
      expect(unsupported).toEqual([]);
    });

    it(`refuses every capability-blind flag ${key}'s engine would reject`, () => {
      for (const flag of new Set(capabilityBlindFlags())) {
        const guard = FLAG_GUARDS[flag];
        if (satisfies(pact, FLAG_CAPABILITIES[flag] ?? [])) {
          if (guard) expect(() => guard(pact), `${flag} is supported on ${key}`).not.toThrow();
          continue;
        }
        expect(guard, `${flag} is unsupported on ${key} and has no guard to refuse it`).toBeDefined();
        expect(() => guard!(pact), `${flag} reaches ${key}'s engine unrefused`).toThrow();
      }
    });
  }
});

describe("capability pact — platform behaviour derived from the recordings", () => {
  // "darwin-arm64 only" is repeated in five user-facing strings; this is the one place the
  // claim meets the binaries, so a Linux diarize build turns it red instead of shipping a lie.
  it("advertises diarization on darwin-arm64 alone", () => {
    const advertising = TARGETS.filter((t) => t.pact.features.includes(TRANSCRIBE_DIARIZE_FEATURE));
    expect(advertising.map((t) => t.key).sort()).toEqual(["darwin-arm64"]);
  });

  for (const { key, platform, arch, pact } of TARGETS) {
    it(`warns on failed text detection exactly where ${key} advertises detect-text-lang`, () => {
      // #770: swallowing the failure off darwin is deliberate, warning on it is deliberate on
      // darwin — both follow from whether that build carries the sidecar at all.
      const advertised = pact.features.includes("detect-text-lang");
      expect(textLangFailureWarning("boom", platform) !== null).toBe(advertised);
    });

    it(`routes only voices ${key}'s engine can synthesise`, () => {
      const advertised = new Set(pact.tts?.languages.map((l) => l.code) ?? []);
      const everyLanguage = new Set(
        TARGETS.flatMap((t) => t.pact.tts?.languages.map((l) => l.code) ?? []),
      );
      const unsupported: string[] = [];
      for (const lang of everyLanguage) {
        const voice = pickVoiceForLang(lang, 0.95, platform, arch);
        // `macos-*` is the AVSpeech sidecar, which serves no downloadable engine language.
        if (!voice || voice.startsWith("macos-")) continue;
        const code = voice.split("-", 1)[0]!;
        if (!advertised.has(code)) unsupported.push(`${lang} -> ${voice}`);
      }
      expect(unsupported).toEqual([]);
    });
  }
});

describe("capability pact — gate strings", () => {
  /**
   * A gate on a capability string no build emits refuses forever. The pacts cannot be the
   * authority here: a capability released after the pinned engine legitimately appears in no
   * pact (`transcribe.itn` and `record.live` are both in that state today), so the Rust source
   * answers "does this string exist" and the pacts answer "on which targets".
   */
  it("gates on capability strings the engine can emit", () => {
    const rust = ["capabilities.rs", "transcribe/mod.rs", "record.rs"]
      .map((file) => readRepoFile(join("rust", "src", file)))
      .join("\n");
    const gated = [
      TRANSCRIBE_SEGMENTS_FEATURE,
      TRANSCRIBE_DIARIZE_FEATURE,
      TRANSCRIBE_ITN_FEATURE,
      RECORD_LIVE_FEATURE,
      ...Object.values(FLAG_CAPABILITIES).flat(),
    ];
    expect(gated.filter((capability) => !rust.includes(`"${capability}"`))).toEqual([]);
  });
});

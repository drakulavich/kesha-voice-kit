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
import {
  pactPath,
  provenancePath,
  type PactProvenance,
} from "../../.github/scripts/record-capability-pacts";
import { buildTranscribeArgs, TRANSCRIBE_DIARIZE_FEATURE, textLangFailureWarning, type EngineCapabilities } from "../../src/engine";
import { validateArgv } from "../../src/engine/describe";
import { KeshaError } from "../../src/engine/events";
import { buildEngineInstallArgs } from "../../src/engine-install";
import { engineTarget, engineTargetEntries, targetKey } from "../../src/engine-targets";
import { pickVoiceForLang } from "../../src/voice-routing";
import { describeDocument } from "../helpers/fake-engine";
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

const PROFILE: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };

function docFor(t: PactTarget) {
  return describeDocument({ backend: t.backend, profile: PROFILE[t.platform]!, features: t.pact.features, tts: t.pact.tts });
}

function rejection(fn: () => unknown): KeshaError | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof KeshaError) return err;
    throw err;
  }
}

describe("capability pact — recordings", () => {
  it("records a pact for every published engine target", () => {
    expect(unrecorded).toEqual([]);
  });

  it("records every target from the same engine release", () => {
    // Mixed versions would gate one platform's flags against another platform's binary.
    expect([...new Set(TARGETS.map((t) => t.provenance.engineVersion))]).toHaveLength(1);
  });

  for (const { key, platform, arch, backend, pact, provenance } of TARGETS) {
    it(`${key} reports the backend src/engine-targets.ts claims it ships`, () => {
      expect(pact.backend).toBe(backend);
    });

    // assetName is pinned against an independent authority; recordedFrom below is only shape-consistency (a consistent multi-field edit passes) — the hash itself belongs to the pact workflow's verify mode (#1138).
    it(`${key} names the asset src/engine-targets.ts publishes`, () => {
      expect(provenance.assetName).toBe(engineTarget(platform, arch)!.assetName);
    });

    it(`${key} says it was recorded from the asset and release it recorded`, () => {
      expect(provenance.recordedFrom).toBe(
        `${provenance.assetName} from release v${provenance.engineVersion}`,
      );
    });
  }

  // Point 4 of #798: an in-process test structurally cannot see a bump that lands on one
  // target only, and the wire format the TS parser reads is shared across all of them.
  it("speaks one protocol version across every target", () => {
    expect([...new Set(TARGETS.map((t) => t.pact.protocolVersion))]).toHaveLength(1);
  });
});

for (const t of TARGETS) describe(`${t.key} accepts what the CLI would send it`, () => {
  const doc = docFor(t);

  it("takes every transcribe flag its features allow", () => {
    const argv = buildTranscribeArgs("a.wav", { vad: "on", itn: true, speakers: t.backend === "coreml" }, true);
    expect(validateArgv(argv, doc).argv).toEqual(argv);
  });

  it("refuses --speakers unless it diarizes", () => {
    const err = rejection(() => validateArgv(buildTranscribeArgs("a.wav", { speakers: true }, true), doc));
    expect(err === null).toBe(t.pact.features.includes("transcribe.diarize"));
  });

  it("takes every install flag, refusing --diarize where the build lacks it", () => {
    const base = buildEngineInstallArgs({ noCache: true, ttsLangs: ["en"], vad: true });
    expect(validateArgv(base, doc).argv).toEqual(base);
    const err = rejection(() => validateArgv(buildEngineInstallArgs({ noCache: false, diarize: true }), doc));
    expect(err === null).toBe(t.pact.features.includes("transcribe.diarize"));
  });

  it("advertises record.live only on the CoreML build", () => {
    expect(t.pact.features.includes("record.live")).toBe(t.backend === "coreml");
  });
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

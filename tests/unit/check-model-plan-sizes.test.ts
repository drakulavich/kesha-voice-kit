import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareEntry,
  contentLength,
  flattenPlan,
  liveSize,
  parseManifestEntries,
  parseManifestUrls,
  type FetchLike,
} from "../../.github/scripts/check-model-plan-sizes";
import modelPlan from "../../model-plan.json" with { type: "json" };

const repoRoot = join(import.meta.dir, "..", "..");
const realManifestSource = () =>
  readFileSync(join(repoRoot, "rust", "src", "models.rs"), "utf8");

const realManifestUrls = () => parseManifestUrls(realManifestSource());
const realManifestEntries = () => parseManifestEntries(realManifestSource());

describe("flattenPlan", () => {
  test("reads arrays, single files and per-language maps alike", () => {
    const entries = flattenPlan({
      vad: [{ relPath: "models/silero-vad/silero_vad.onnx", sizeBytes: 2327524 }],
      kokoroGraph: { relPath: "models/kokoro-82m/model.onnx", sizeBytes: 325532387 },
      kokoroVoices: {
        en: { relPath: "models/kokoro-82m/voices/am_michael.bin", sizeBytes: 522240 },
      },
    });

    expect(entries).toEqual([
      { group: "vad", relPath: "models/silero-vad/silero_vad.onnx", sizeBytes: 2327524 },
      { group: "kokoroGraph", relPath: "models/kokoro-82m/model.onnx", sizeBytes: 325532387 },
      {
        group: "kokoroVoices.en",
        relPath: "models/kokoro-82m/voices/am_michael.bin",
        sizeBytes: 522240,
      },
    ]);
  });

  test("refuses an entry with no recorded size rather than skipping it", () => {
    expect(() => flattenPlan({ vad: [{ relPath: "models/silero-vad/silero_vad.onnx" }] })).toThrow(
      /sizeBytes/,
    );
  });
});

describe("parseManifestUrls", () => {
  test("reads a plain ModelFile, including a url wrapped onto its own line", () => {
    const urls = parseManifestUrls(`
      const VOSK_RU_FILES: &[ModelFile] = &[
          ModelFile {
              rel_path: "models/vosk-ru/model.onnx",
              url: "https://example.test/model.onnx",
              sha256: "aa",
          },
          ModelFile {
              rel_path: "models/vosk-ru/bert/vocab.txt",
              url:
                  "https://example.test/bert/vocab.txt",
              sha256: "bb",
          },
      ];
    `);

    expect(urls.get("models/vosk-ru/model.onnx")).toBe("https://example.test/model.onnx");
    expect(urls.get("models/vosk-ru/bert/vocab.txt")).toBe("https://example.test/bert/vocab.txt");
  });

  test("expands a macro-built entry through the macro's own url template", () => {
    const urls = parseManifestUrls(`
      macro_rules! kokoro_voice {
          ($name:literal, $sha:literal) => {
              ModelFile {
                  rel_path: concat!("models/kokoro-82m/voices/", $name, ".bin"),
                  url: concat!(
                      "https://example.test/voices/",
                      $name,
                      ".bin"
                  ),
                  sha256: $sha,
              }
          };
      }

      const KOKORO_EN_VOICE: ModelFile = kokoro_voice!("am_michael", "cc");
    `);

    expect(urls.get("models/kokoro-82m/voices/am_michael.bin")).toBe(
      "https://example.test/voices/am_michael.bin",
    );
  });

  test("resolves a url for every model-plan.json entry against the real manifest", () => {
    const unresolved = flattenPlan(modelPlan).filter((entry) => !realManifestUrls().has(entry.relPath));
    expect(unresolved.map((entry) => entry.relPath)).toEqual([]);
  });

  // Presence alone passes on a parser emitting a truncated or wrong-host URL; the weekly HEAD would then read that as a size mismatch, not a parse bug.
  test("reads the real manifest's urls byte-exact, not merely non-empty", () => {
    const urls = realManifestUrls();

    expect(urls.get("models/parakeet-tdt-v3/vocab.txt")).toBe(
      "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/vocab.txt",
    );
    expect(urls.get("models/kokoro-82m/voices/am_michael.bin")).toBe(
      "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/am_michael.bin",
    );
    expect(
      urls.get("models/diarize/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/0-weight.bin"),
    ).toBe(
      "https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml/resolve/ae9a27ab45dc0aa3abede7d2d6bad2b7a69aa6d1/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/0-weight.bin",
    );
  });

  // The English and Mandarin ANE bundles stage identical basenames (e.g.
  // `KokoroAlbert.mlmodelc/analytics/coremldata.bin`) into different directories at install
  // time — `stage_into(&fluidaudio_ane_kokoro_dir()?, ANE_EN_FILES, …)` vs `stage_into(&zh,
  // ANE_ZH_FILES, …)` — so `relPath` is not unique across the manifest. `parseManifestUrls`'s
  // map would let the later declaration (`ANE_ZH_FILES`) silently shadow the earlier one
  // (`ANE_EN_FILES`) for every colliding key; `parseManifestEntries` must keep both.
  test("keeps colliding rel_paths as separate entries rather than letting one shadow the other", () => {
    const albertCoremldata = realManifestEntries().filter(
      (entry) => entry.relPath === "KokoroAlbert.mlmodelc/analytics/coremldata.bin",
    );
    expect(albertCoremldata).toHaveLength(2);
    expect(albertCoremldata.map((entry) => entry.url)).toEqual([
      expect.stringContaining("/ANE/KokoroAlbert.mlmodelc/analytics/coremldata.bin"),
      expect.stringContaining("/ANE-zh/KokoroAlbert.mlmodelc/analytics/coremldata.bin"),
    ]);
  });

  // `parseManifestEntries` expands the `ModelFile`-building macros in place, so this sees
  // every manifest models.rs declares regardless of `cfg` — including the `system_kokoro`
  // ANE ones no CI lane ever compiles as tests (#1093, #1096 review) — and every entry, not
  // just one per colliding `relPath` (the test above). `manifest_tests::
  // every_huggingface_url_pins_an_immutable_revision` in models.rs covers the same rule with
  // real Rust types where it does run; this is the one that runs everywhere.
  // Asserted positively — a denylist of `main` alone let `resolve//` through unseen.
  test("no Hugging Face manifest URL resolves through a mutable ref", () => {
    const mutableRefs: string[] = [];
    for (const { relPath, url } of realManifestEntries()) {
      if (!url.startsWith("https://huggingface.co/")) continue;
      const afterResolve = url.split("/resolve/")[1];
      const ref = afterResolve?.split("/")[0] ?? "";
      if (!/^[0-9a-f]{40}$/.test(ref)) mutableRefs.push(`${relPath}: ${url}`);
    }
    expect(mutableRefs).toEqual([]);
  });

  test("the silero-vad manifest URL pins a 40-hex commit, not the movable v6.2.1 tag", () => {
    const vad = realManifestEntries().find(
      (entry) => entry.relPath === "models/silero-vad/silero_vad.onnx",
    );
    const ref = vad?.url.split("/raw/")[1]?.split("/")[0] ?? "";
    expect(/^[0-9a-f]{40}$/.test(ref)).toBe(true);
  });
});

describe("compareEntry", () => {
  const entry = {
    group: "g2pCharsiu",
    relPath: "models/g2p/byt5-tiny/encoder_model.onnx",
    sizeBytes: 57234020,
  };

  test("passes when the live length equals the recorded size", () => {
    expect(compareEntry(entry, 57234020).status).toBe("ok");
  });

  // The #896 drift: the plan recorded 12478704 for a file upstream serves as 57234020.
  test("names the recorded size, the live size and the delta on drift", () => {
    const verdict = compareEntry({ ...entry, sizeBytes: 12478704 }, 57234020);

    expect(verdict.status).toBe("drift");
    expect(verdict.message).toContain("models/g2p/byt5-tiny/encoder_model.onnx");
    expect(verdict.message).toContain("12478704");
    expect(verdict.message).toContain("11.9 MB");
    expect(verdict.message).toContain("57234020");
    expect(verdict.message).toContain("54.6 MB");
    expect(verdict.message).toContain("+44755316");
    expect(verdict.message).toContain("+42.7 MB");
  });

  test("reports a shrunk file with a negative delta", () => {
    const verdict = compareEntry(entry, 57234000);

    expect(verdict.status).toBe("drift");
    expect(verdict.message).toContain("-20 bytes");
  });

  test("separates an unreadable length from drift", () => {
    const verdict = compareEntry(entry, null);

    expect(verdict.status).toBe("unchecked");
    expect(verdict.message).toContain("models/g2p/byt5-tiny/encoder_model.onnx");
  });
});

describe("contentLength", () => {
  test("reads a plain byte count", () => {
    expect(contentLength(new Headers({ "content-length": "93939" }))).toBe(93939);
  });

  test("refuses a compressed length, which measures the transfer and not the file", () => {
    expect(
      contentLength(new Headers({ "content-length": "31000", "content-encoding": "gzip" })),
    ).toBeNull();
  });

  test("accepts an explicit identity encoding", () => {
    expect(
      contentLength(new Headers({ "content-length": "646", "content-encoding": "identity" })),
    ).toBe(646);
  });

  test("yields nothing when the header is absent or unparseable", () => {
    expect(contentLength(new Headers())).toBeNull();
    expect(contentLength(new Headers({ "content-length": "many" }))).toBeNull();
  });
});

describe("liveSize", () => {
  const url = "https://example.test/vocab.txt";

  test("asks for an uncompressed body, so the length is the file and not the transfer", async () => {
    // HuggingFace gzips small text files unless identity is requested: `vocab.txt`
    // answers 93939 with identity and no Content-Length at all without it.
    const gzipUnlessIdentity: FetchLike = async (_input, init) =>
      new Response(null, {
        headers:
          new Headers(init?.headers).get("accept-encoding") === "identity"
            ? { "content-length": "93939" }
            : { "content-encoding": "gzip" },
      });

    expect(await liveSize(url, { fetchImpl: gzipUnlessIdentity, backoffMs: 0 })).toBe(93939);
  });

  test("follows the redirect that carries the real length", async () => {
    // HF `resolve/` URLs 302 to a CDN; only the final response knows the size.
    const redirecting: FetchLike = async (_input, init) =>
      init?.redirect === "follow"
        ? new Response(null, { headers: { "content-length": "2435420160" } })
        : new Response(null, { status: 302, headers: { location: "https://cdn.example.test/x" } });

    expect(await liveSize(url, { fetchImpl: redirecting, backoffMs: 0 })).toBe(2435420160);
  });

  test("retries, so a single blip does not read as drift", async () => {
    let calls = 0;
    const flaky: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
      return new Response(null, { headers: { "content-length": "646" } });
    };

    expect(await liveSize(url, { fetchImpl: flaky, backoffMs: 0 })).toBe(646);
  });

  test("retries a 200 that carries no usable length, not just a dropped connection", async () => {
    let calls = 0;
    const omitsLengthOnce: FetchLike = async () => {
      calls += 1;
      return new Response(null, { headers: calls === 1 ? {} : { "content-length": "2327524" } });
    };

    expect(await liveSize(url, { fetchImpl: omitsLengthOnce, backoffMs: 0 })).toBe(2327524);
  });

  test("learns the length from a one-byte range when HEAD carries no length at all", async () => {
    // raw.githubusercontent.com answers HEAD 200 with no Content-Length header (#1054), which
    // left silero_vad.onnx — the plan's only non-HuggingFace entry — permanently unmeasurable.
    const ranges: string[] = [];
    const rawGithub: FetchLike = async (_input, init) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      ranges.push(new Headers(init?.headers).get("range") ?? "");
      return new Response("x", {
        status: 206,
        headers: { "content-range": "bytes 0-0/2327524", "content-length": "1" },
      });
    };

    // The total the range reports, never the single byte it served.
    expect(await liveSize(url, { fetchImpl: rawGithub, backoffMs: 0 })).toBe(2327524);
    expect(ranges).toEqual(["bytes=0-0"]);
  });

  test("gives up rather than guessing when the host keeps failing", async () => {
    const dead: FetchLike = async () => new Response(null, { status: 404 });

    expect(await liveSize(url, { fetchImpl: dead, backoffMs: 0 })).toBeNull();
  });
});

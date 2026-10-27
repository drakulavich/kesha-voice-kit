import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readRepoFile, repoPath } from "../helpers/repo";

const MANIFEST_RS = readRepoFile("rust/src/models/manifest.rs");
const MINI_DIR = "tests/fixtures/mini-models/kokoro";

function mustMatch(source: string, re: RegExp, what: string): RegExpMatchArray {
  const m = source.match(re);
  if (!m) throw new Error(`could not parse ${what}; did its source change shape?`);
  return m;
}

const kokoroGraph = (() => {
  const block = mustMatch(MANIFEST_RS, /const KOKORO_GRAPH: ModelFile = ModelFile \{([\s\S]*?)\};/, "KOKORO_GRAPH in manifest.rs")[1]!;
  return {
    url: mustMatch(block, /url: "([^"]+)"/, "KOKORO_GRAPH.url")[1]!,
    sha256: mustMatch(block, /sha256: "([0-9a-f]{64})"/, "KOKORO_GRAPH.sha256")[1]!,
  };
})();

describe("recorded fixtures follow the engine's pins", () => {
  test("the Kokoro signature was recorded from the model manifest.rs installs", () => {
    const signature = JSON.parse(readRepoFile(`${MINI_DIR}/signature.json`));
    expect(signature.source_url).toBe(kokoroGraph.url);
    expect(signature.recorded_from_sha256).toBe(kokoroGraph.sha256);
  });

  test("download-kokoro.sh fetches the Kokoro model and voices manifest.rs pins", () => {
    const script = readRepoFile("rust/ci/download-kokoro.sh");
    const assigned = (name: string) => mustMatch(script, new RegExp(`^${name}=(\\S+)$`, "m"), `${name} in download-kokoro.sh`)[1]!;
    expect(assigned("KOKORO_MODEL_URL")).toBe(kokoroGraph.url);
    expect(assigned("KOKORO_MODEL_SHA256")).toBe(kokoroGraph.sha256);

    const revision = mustMatch(MANIFEST_RS, /macro_rules! kokoro_voice \{[\s\S]*?\/resolve\/([0-9a-f]{40})\/voices\//, "the kokoro_voice! revision")[1]!;
    expect(assigned("KOKORO_VOICE_REVISION")).toBe(revision);

    const manifestVoices = Object.fromEntries(
      [...MANIFEST_RS.matchAll(/(?<![\w])kokoro_voice!\(\s*"(\w+)",\s*"([0-9a-f]{64})"\s*\)/g)].map((m) => [m[1]!, m[2]!]),
    );
    const scriptVoices = Object.fromEntries([...script.matchAll(/^KOKORO_VOICE_SHA256_(\w+)=([0-9a-f]{64})$/gm)].map((m) => [m[1]!, m[2]!]));
    expect(Object.keys(manifestVoices).length).toBeGreaterThan(0);
    expect(scriptVoices).toEqual(manifestVoices);
  });

  test.each([
    { list: "G2P_CHARSIU_FILES", prefix: "CHARSIU", dir: "models/g2p/byt5-tiny/", ext: ".onnx" },
    { list: "VOSK_RU_FILES", prefix: "VOSK", dir: "models/vosk-ru/", ext: "" },
  ])("download-kokoro.sh fetches the $list revision and hashes manifest.rs pins", ({ list, prefix, dir, ext }) => {
    const script = readRepoFile("rust/ci/download-kokoro.sh");
    const block = mustMatch(MANIFEST_RS, new RegExp(`const ${list}: &\\[ModelFile\\] = &\\[([\\s\\S]*?)\\n\\];`), list)[1]!;
    const entries = [...block.matchAll(/rel_path: "([^"]+)",\s*url:\s*"[^"]*\/resolve\/([0-9a-f]{40})\/[^"]*",\s*sha256: "([0-9a-f]{64})"/g)];
    expect(entries.length).toBeGreaterThan(0);

    const revisions = new Set(entries.map((m) => m[2]!));
    expect(revisions.size).toBe(1);
    const scriptRevision = mustMatch(script, new RegExp(`^${prefix}_REVISION=(\\S+)$`, "m"), `${prefix}_REVISION`)[1]!;
    expect(scriptRevision).toBe([...revisions][0]!);

    const manifestFiles = Object.fromEntries(entries.map((m) => [m[1]!.slice(dir.length, m[1]!.length - ext.length).replace(/[/.]/g, "_"), m[3]!]));
    const scriptFiles = Object.fromEntries([...script.matchAll(new RegExp(`^${prefix}_SHA256_(\\w+)=([0-9a-f]{64})$`, "gm"))].map((m) => [m[1]!, m[2]!]));
    expect(scriptFiles).toEqual(manifestFiles);
  });

  test("the committed mini model files are the bytes MINI-MODEL.json records", () => {
    const marker = JSON.parse(readRepoFile(`${MINI_DIR}/MINI-MODEL.json`));
    const files = Object.entries(marker.files as Record<string, { bytes: number; sha256: string }>);
    expect(files.length).toBeGreaterThan(0);
    for (const [name, recorded] of files) {
      const bytes = readFileSync(repoPath(`${MINI_DIR}/${name}`));
      expect({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }).toEqual({
        name,
        ...recorded,
      });
    }
  });
});

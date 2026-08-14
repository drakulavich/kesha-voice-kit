import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readRepoFile } from "../helpers/repo";

// The plugin entry is CommonJS because it runs inside OpenClaw's runtime, not Kesha's.
const require = createRequire(import.meta.url);

type MediaProviderRegistration = {
  id: string;
  capabilities?: string[];
  defaultModels?: Record<string, string>;
  autoPriority?: Record<string, number>;
  transcribeAudio?: unknown;
};

function loadPlugin() {
  return require("../../openclaw-plugin.cjs") as {
    id: string;
    name: string;
    register: (api: {
      registerMediaUnderstandingProvider: (reg: MediaProviderRegistration) => void;
    }) => void;
  };
}

function captureRegistrations(): MediaProviderRegistration[] {
  const registrations: MediaProviderRegistration[] = [];
  loadPlugin().register({
    registerMediaUnderstandingProvider: (reg) => registrations.push(reg),
  });
  return registrations;
}

describe("openclaw plugin registration", () => {
  test("registers exactly one audio media-understanding provider (discoverability)", () => {
    const registrations = captureRegistrations();

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.id).toBe("kesha-voice-kit");
    expect(registrations[0]?.capabilities).toEqual(["audio"]);
    expect(registrations[0]?.defaultModels).toEqual({ audio: "parakeet-tdt-0.6b-v3" });
    expect(registrations[0]?.autoPriority).toEqual({ audio: 50 });
  });

  // #933: the provider is declaration-only. A transcription handler would make it
  // selectable, resurrecting the ~45-line dead path the documented config never reaches.
  test("the provider carries no transcription handler", () => {
    const [registration] = captureRegistrations();

    expect(registration?.transcribeAudio).toBeUndefined();
  });
});

describe("openclaw plugin source stays scanner-clean", () => {
  const source = readRepoFile("openclaw-plugin.cjs");

  // Reproduces OpenClaw's `dangerous-exec` rule (src/security/skill-scanner.ts):
  // it fires only when a bare command-running call AND the forbidden module
  // substring both appear in one file — comments included, since the scan is raw text.
  const COMMAND_CALL = /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/;
  const FORBIDDEN_MODULE = new RegExp("child_" + "process");

  test("the dangerous-exec rule does not fire", () => {
    const fires = COMMAND_CALL.test(source) && FORBIDDEN_MODULE.test(source);

    expect(fires).toBe(false);
  });

  test("the forbidden module substring is absent from the source", () => {
    expect(FORBIDDEN_MODULE.test(source)).toBe(false);
  });
});

describe("openclaw package contracts", () => {
  const manifest = JSON.parse(readRepoFile("openclaw.plugin.json")) as {
    id?: string;
    configSchema?: {
      type?: string;
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    configPatch?: unknown;
  };
  const packageJson = JSON.parse(readRepoFile("package.json")) as {
    openclaw?: {
      extensions?: string[];
      compat?: { pluginApi?: string };
      build?: { openclawVersion?: string };
    };
  };

  test("ships an installable manifest with an empty object config schema", () => {
    expect(manifest.id).toBe("kesha-voice-kit");
    expect(manifest.configSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(manifest.configPatch).toBeUndefined();
  });

  test("declares every OpenClaw publish requirement", () => {
    expect(packageJson.openclaw?.extensions).toEqual(["./openclaw-plugin.cjs"]);
    expect(packageJson.openclaw?.compat?.pluginApi).toBe(">=2026.5.27");
    expect(packageJson.openclaw?.build?.openclawVersion).toBe("2026.5.27");
  });
});

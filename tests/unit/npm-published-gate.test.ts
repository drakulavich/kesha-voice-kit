import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { assertNpmPublished } from "../../.github/scripts/assert-npm-published.mjs";

type Packument = { versions?: Record<string, unknown>; "dist-tags"?: Record<string, string> };

function registry(body: Packument, status = 200) {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

const PUBLISHED: Packument = {
  versions: { "1.25.0": {}, "1.26.0": {}, "1.27.0-alpha.1": {} },
  "dist-tags": { latest: "1.26.0", alpha: "1.27.0-alpha.1" },
};

async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the assertion to reject");
}

describe("assertNpmPublished", () => {
  test("a published version passes", async () => {
    expect(await assertNpmPublished("1.26.0", registry(PUBLISHED))).toBeUndefined();
  });

  test("an unpublished version is refused, naming it, npm latest and the issue", async () => {
    const error = await rejection(assertNpmPublished("1.27.0", registry(PUBLISHED)));

    expect(error.code).toBe("E_VERSION_UNPUBLISHED");
    expect(error.message).toContain("1.27.0 was never published");
    expect(error.message).toContain("latest is 1.26.0");
    expect(error.message).toContain("v1.27.0-cli");
    expect(error.message).toContain("#728");
  });

  test("a registry that cannot be reached is its own failure, not an absent version", async () => {
    const offline = async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    };
    const error = await rejection(assertNpmPublished("1.26.0", offline as unknown as typeof fetch));

    expect(error.code).toBe("E_REGISTRY_UNREACHABLE");
    expect(error.message).toContain("ENOTFOUND");
  });

  test("an HTTP error is unreachable rather than unpublished", async () => {
    const error = await rejection(assertNpmPublished("1.26.0", registry(PUBLISHED, 503)));

    expect(error.code).toBe("E_REGISTRY_UNREACHABLE");
    expect(error.message).toContain("HTTP 503");
  });

  // An empty or reshaped payload would otherwise refuse every version as unpublished.
  test("a packument with no versions is unreachable, not a verdict", async () => {
    const error = await rejection(assertNpmPublished("1.26.0", registry({})));

    expect(error.code).toBe("E_REGISTRY_UNREACHABLE");
    expect(error.message).toContain("no published versions");
  });

  test("a body that is not JSON is unreachable", async () => {
    const garbage = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }) as unknown as Response;
    const error = await rejection(assertNpmPublished("1.26.0", garbage as unknown as typeof fetch));

    expect(error.code).toBe("E_REGISTRY_UNREACHABLE");
  });
});

describe("the release gates on it before naming a package", () => {
  const steps = parse(
    readFileSync(`${import.meta.dir}/../../.github/workflows/build-engine.yml`, "utf8"),
  ).jobs.release.steps as Array<{ name?: string; if?: string; run?: string }>;
  const index = (name: string) => steps.findIndex((s) => s.name === name);
  const gate = index("Assert the packaged CLI version is published on npm");

  test("the assert runs only on the path that attaches packages", () => {
    expect(steps[gate].if).toBe("steps.release_kind.outputs.prerelease != 'true'");
    expect(steps[gate].run).toContain("assert-npm-published.mjs");
  });

  test("it runs before the packages are built and before the manifest names them", () => {
    expect(gate).toBeLessThan(index("Build Linux deb/rpm packages"));
    expect(gate).toBeLessThan(index("Generate release manifest"));
  });
});

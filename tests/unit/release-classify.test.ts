import { describe, expect, test } from "bun:test";
import { classifyRelease, formatOutputs, type ClassifyInput } from "../../.github/scripts/release-classify";

const pkg = (version: string) => ({ version });

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return { eventName: "push", refType: "tag", refName: "v2.0.0", pkg: pkg("2.0.0"), ...over };
}

describe("classifyRelease — tag pushes", () => {
  test("a stable tag at package.json#version is the stable path on the stable channel", () => {
    expect(classifyRelease(input({}))).toEqual({
      path: "stable",
      channel: "stable",
      version: "2.0.0",
      tag: "v2.0.0",
      prerelease: false,
      distTag: "latest",
      buildEngine: true,
      publish: true,
    });
  });

  test("a beta tag at package.json#version is a published prerelease on the beta dist-tag", () => {
    const out = classifyRelease(input({ refName: "v2.1.0-beta.1", pkg: pkg("2.1.0-beta.1") }));
    expect(out).toMatchObject({ path: "beta", channel: "beta", prerelease: true, distTag: "beta", buildEngine: true });
  });

  test("a tag whose version the commit does not carry fails before building, naming both", () => {
    expect(() => classifyRelease(input({ refName: "v2.0.1" }))).toThrow(/v2\.0\.1.*2\.0\.0/);
  });

  test("the legacy -cli marker is refused, naming the accepted shapes", () => {
    expect(() => classifyRelease(input({ refName: "v2.0.1-cli" }))).toThrow(/vX\.Y\.Z-beta\.N/);
  });

  test("an alpha tag is a record, never a trigger", () => {
    expect(() => classifyRelease(input({ refName: "v2.0.0-alpha.3", pkg: pkg("2.0.0-alpha.3") }))).toThrow(/record/);
  });

  for (const bad of ["2.0.0", "v2.0", "v2.0.0-rc.1", "v2.0.0-beta", "v2.0.0\nx=1", "v02.0.0x"]) {
    test(`an unshaped tag ${JSON.stringify(bad)} is refused`, () => {
      expect(() => classifyRelease(input({ refName: bad }))).toThrow(/accepted/);
    });
  }

  test("a branch push other than main starts nothing", () => {
    expect(() => classifyRelease(input({ refType: "branch", refName: "feature" }))).toThrow(/main/);
  });
});

describe("classifyRelease — main pushes and dispatches", () => {
  test("a push to main is the per-merge CLI alpha: no Engine build, alpha dist-tag, version derived later", () => {
    const out = classifyRelease(input({ refType: "branch", refName: "main" }));
    expect(out).toMatchObject({ path: "cli-alpha", channel: "alpha", distTag: "alpha", buildEngine: false, prerelease: true });
    expect(out.version).toBe("");
  });

  test("a dispatched beta carries its version and must extend package.json#version", () => {
    const out = classifyRelease(
      input({ eventName: "workflow_dispatch", refType: "branch", refName: "main", dispatch: { channel: "beta", version: "2.0.0-beta.2" } }),
    );
    expect(out).toMatchObject({ path: "beta", channel: "beta", version: "2.0.0-beta.2", tag: "v2.0.0-beta.2", buildEngine: true });
  });

  test("a dispatched beta of another base is refused", () => {
    expect(() =>
      classifyRelease(input({ eventName: "workflow_dispatch", refType: "branch", dispatch: { channel: "beta", version: "2.1.0-beta.1" } })),
    ).toThrow(/2\.0\.0/);
  });

  test("a dispatched beta without a beta-shaped version is refused", () => {
    expect(() =>
      classifyRelease(input({ eventName: "workflow_dispatch", refType: "branch", dispatch: { channel: "beta", version: "2.0.0" } })),
    ).toThrow(/beta/);
  });

  test("a dispatched alpha builds the Engine unless it names an Engine prerelease", () => {
    const base = { eventName: "workflow_dispatch", refType: "branch", refName: "main" } as const;
    expect(classifyRelease(input({ ...base, dispatch: { channel: "alpha" } }))).toMatchObject({
      path: "alpha",
      channel: "alpha",
      buildEngine: true,
    });
    expect(
      classifyRelease(input({ ...base, dispatch: { channel: "alpha", enginePrerelease: "v2.0.0-beta.1" } })),
    ).toMatchObject({ path: "alpha", buildEngine: false });
  });

  test("an unshaped engine-prerelease is refused", () => {
    expect(() =>
      classifyRelease(
        input({ eventName: "workflow_dispatch", refType: "branch", dispatch: { channel: "alpha", enginePrerelease: "v2.0.0" } }),
      ),
    ).toThrow(/prerelease/);
  });

  test("a dispatch naming no known channel is refused", () => {
    expect(() =>
      classifyRelease(input({ eventName: "workflow_dispatch", refType: "branch", dispatch: { channel: "stable" } })),
    ).toThrow(/tag/);
  });
});

describe("classifyRelease — rehearsal", () => {
  test("a pull request rehearses the stable path and publishes nothing", () => {
    const out = classifyRelease(input({ eventName: "pull_request", refType: "branch", refName: "1/merge" }));
    expect(out).toMatchObject({ path: "rehearsal", channel: "stable", publish: false, buildEngine: true, version: "2.0.0" });
  });

  test("a rehearsal builds the one committed version, whatever else package.json carries", () => {
    const out = classifyRelease(input({ eventName: "pull_request", refType: "branch", pkg: { version: "1.32.0", keshaEngine: { version: "1.26.0" } } as { version: string } }));
    expect(out.version).toBe("1.32.0");
  });

  test("an unknown event is refused", () => {
    expect(() => classifyRelease(input({ eventName: "release" }))).toThrow(/release/);
  });
});

describe("formatOutputs", () => {
  test("prints one GITHUB_OUTPUT line per field with booleans spelled out", () => {
    const text = formatOutputs(classifyRelease(input({})));
    expect(text).toContain("path=stable\n");
    expect(text).toContain("build_engine=true\n");
    expect(text).toContain("dist_tag=latest\n");
    expect(text.split("\n").filter(Boolean)).toHaveLength(9);
  });

  test("carries the whole classification as one JSON line, booleans intact, for the plan job", () => {
    const c = classifyRelease(input({ eventName: "pull_request", refType: "branch" }));
    const json = formatOutputs(c).split("\n").find((line) => line.startsWith("json="))!;
    expect(JSON.parse(json.slice(5))).toEqual(c);
  });
});

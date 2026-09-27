#!/usr/bin/env bun
/**
 * Decide what one `release.yml` run does, from its trigger alone (openspec `unified-release` D2).
 *
 * A tag or a dispatch runs a release path, a push to `main` the per-merge CLI alpha, and a pull
 * request a rehearsal that builds and smokes everything and publishes nothing. Prints
 * `$GITHUB_OUTPUT` lines; any refusal exits 1 before a single build minute is spent.
 */
import { readFileSync } from "node:fs";

export type Path = "stable" | "beta" | "alpha" | "cli-alpha" | "rehearsal";
export type Channel = "stable" | "beta" | "alpha";

export type ClassifyInput = {
  eventName: string;
  refType: string;
  refName: string;
  pkg: { version: string; keshaEngine?: { version?: string } };
  dispatch?: { channel?: string; version?: string; enginePrerelease?: string };
};

export type Classification = {
  path: Path;
  channel: Channel;
  /** Empty on `cli-alpha`: the alpha jobs derive it from the tags inside the publish queue. */
  version: string;
  tag: string;
  prerelease: boolean;
  distTag: "latest" | "beta" | "alpha";
  buildEngine: boolean;
  publish: boolean;
};

const ACCEPTED = "accepted shapes are vX.Y.Z, vX.Y.Z-beta.N and vX.Y.Z-alpha.N";
const TAG = /^v(\d+\.\d+\.\d+)(?:-(alpha|beta)\.\d+)?$/;
const BETA_VERSION = /^(\d+\.\d+\.\d+)-beta\.\d+$/;
const PRERELEASE_TAG = /^v\d+\.\d+\.\d+-(alpha|beta)\.\d+$/;
const DIST_TAG: Record<Channel, Classification["distTag"]> = { stable: "latest", beta: "beta", alpha: "alpha" };

function release(path: Path, channel: Channel, version: string, buildEngine: boolean): Classification {
  return {
    path,
    channel,
    version,
    tag: version ? `v${version}` : "",
    prerelease: channel !== "stable",
    distTag: DIST_TAG[channel],
    buildEngine,
    publish: path !== "rehearsal",
  };
}

const base = (version: string) => version.replace(/-.*$/, "");

function fromTag(tag: string, pkgVersion: string): Classification {
  const match = TAG.exec(tag);
  if (!match) throw new Error(`tag ${JSON.stringify(tag)} starts no release — the ${ACCEPTED}`);
  const kind = match[2];
  if (kind === "alpha") {
    throw new Error(`${tag} is an alpha record written after its publish; pushing it starts nothing`);
  }
  const version = tag.slice(1);
  if (version !== pkgVersion) {
    throw new Error(`tag ${tag} names ${version} but package.json#version at that commit is ${pkgVersion}`);
  }
  return kind === "beta" ? release("beta", "beta", version, true) : release("stable", "stable", version, true);
}

function fromDispatch(dispatch: ClassifyInput["dispatch"], pkgVersion: string): Classification {
  const channel = dispatch?.channel;
  if (channel === "beta") {
    const version = dispatch?.version ?? "";
    const match = BETA_VERSION.exec(version);
    if (!match) throw new Error(`a beta dispatch needs a version shaped X.Y.Z-beta.N, got ${JSON.stringify(version)}`);
    if (match[1] !== base(pkgVersion)) {
      throw new Error(`beta ${version} must extend package.json#version ${base(pkgVersion)}`);
    }
    return release("beta", "beta", version, true);
  }
  if (channel === "alpha") {
    const engine = dispatch?.enginePrerelease ?? "";
    if (engine && !PRERELEASE_TAG.test(engine)) {
      throw new Error(`engine-prerelease must name an Engine prerelease tag (vX.Y.Z-alpha.N or -beta.N), got ${engine}`);
    }
    return release("alpha", "alpha", "", engine === "");
  }
  throw new Error(`a dispatch publishes beta or alpha; a stable release is a pushed tag (got ${JSON.stringify(channel)})`);
}

export function classifyRelease(input: ClassifyInput): Classification {
  const { eventName, refType, refName, pkg } = input;
  if (eventName === "pull_request") {
    // Until the versions are unified the CLI still pins an older Engine, and the smoke must stage that one.
    return release("rehearsal", "stable", pkg.keshaEngine?.version ?? pkg.version, true);
  }
  if (eventName === "workflow_dispatch") return fromDispatch(input.dispatch, pkg.version);
  if (eventName !== "push") throw new Error(`release.yml does not handle the ${eventName} event`);
  if (refType === "tag") return fromTag(refName, pkg.version);
  if (refName !== "main") throw new Error(`only a push to main publishes a CLI alpha, not a push to ${refName}`);
  return release("cli-alpha", "alpha", "", false);
}

export function formatOutputs(c: Classification): string {
  return [
    `path=${c.path}`,
    `channel=${c.channel}`,
    `version=${c.version}`,
    `tag=${c.tag}`,
    `prerelease=${c.prerelease}`,
    `dist_tag=${c.distTag}`,
    `build_engine=${c.buildEngine}`,
    `publish=${c.publish}`,
  ]
    .map((line) => `${line}\n`)
    .join("");
}

if (import.meta.main) {
  const env = process.env;
  const input: ClassifyInput = {
    eventName: env.EVENT_NAME ?? "",
    refType: env.REF_TYPE ?? "",
    refName: env.REF_NAME ?? "",
    pkg: JSON.parse(readFileSync("package.json", "utf8")),
    dispatch: { channel: env.INPUT_CHANNEL, version: env.INPUT_VERSION, enginePrerelease: env.INPUT_ENGINE_PRERELEASE },
  };
  try {
    process.stdout.write(formatOutputs(classifyRelease(input)));
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

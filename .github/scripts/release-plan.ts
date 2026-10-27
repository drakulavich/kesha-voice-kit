#!/usr/bin/env bun
/**
 * Turn a classified release.yml run into what it publishes: the version, its tag, the Engine the
 * CLI resolves (openspec unified-release D1) and whether anything is published at all.
 *
 * Alpha versions live only in tags. Legacy `-cli` alpha and stable tags are counted too, because
 * npm already holds those versions and a reused one would be silently skipped as published.
 */
import { readFileSync } from "node:fs";
import { cmp, isStableVersion, parseSemver } from "../../src/semver.mjs";
import { newestStableRelease } from "./engine-pin";
import type { Classification } from "./release-classify";

type Release = { tagName: string; isDraft: boolean; isPrerelease: boolean };

export type Plan = { version: string; tag: string; engineVersion: string; publish: boolean; previous: string };

export type PlanInput = {
  classification: Classification;
  pkgVersion: string;
  tags: string[];
  releases: Release[];
  /** The label and packed-path verdict of a per-merge alpha. */
  publishable?: boolean;
  enginePrerelease?: string;
};

const PUBLISHED = /^v(\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?)(?:-cli)?$/;
const STABLE = /^v(\d+\.\d+\.\d+)(?:-cli)?$/;

function highest(tags: string[], shape: RegExp): { tag: string; version: string } | undefined {
  let best: { tag: string; version: string } | undefined;
  for (const tag of tags.map((t) => t.trim())) {
    const version = shape.exec(tag)?.[1];
    if (!version) continue;
    if (!best || cmp(parseSemver(version, "tag"), parseSemver(best.version, "tag")) > 0) best = { tag, version };
  }
  return best;
}

export function deriveReleaseAlpha(base: string, tags: string[]): { version: string; tag: string; previous: string } {
  if (tags.length === 0) {
    throw new Error("no tags visible — refusing to restart the alpha sequence at 1; fetch full history and tags first");
  }
  if (!isStableVersion(base)) throw new Error(`alpha base must be a stable version, got ${base}`);
  const stable = highest(tags, STABLE);
  if (stable && cmp(parseSemver(base, "alpha base"), parseSemver(stable.version, "stable")) <= 0) {
    throw new Error(
      `alpha base ${base} does not lead the published stable ${stable.tag}, so ${base}-alpha.N would sort below it. ` +
        "Fix: bump package.json#version on main to the next unreleased version.",
    );
  }
  const escaped = base.replace(/\./g, "\\.");
  const sequence = new RegExp(`^v${escaped}-alpha\\.(\\d+)(?:-cli)?$`);
  const n = Math.max(0, ...tags.map((t) => Number(sequence.exec(t.trim())?.[1] ?? 0))) + 1;
  const version = `${base}-alpha.${n}`;
  return { version, tag: `v${version}`, previous: highest(tags, PUBLISHED)?.tag ?? "" };
}

export function planRelease(input: PlanInput): Plan {
  const c = input.classification;
  if (c.path === "cli-alpha") {
    if (!input.publishable) return { version: "", tag: "", engineVersion: "", publish: false, previous: "" };
    const alpha = deriveReleaseAlpha(input.pkgVersion, input.tags);
    return { ...alpha, engineVersion: newestStableRelease(input.releases), publish: true };
  }
  if (c.path === "alpha") {
    const alpha = deriveReleaseAlpha(input.pkgVersion, input.tags);
    const engineVersion = input.enginePrerelease ? input.enginePrerelease.replace(/^v/, "") : alpha.version;
    return { ...alpha, engineVersion, publish: true };
  }
  return { version: c.version, tag: c.tag, engineVersion: c.version, publish: c.publish, previous: "" };
}

function git(args: string[]): string {
  const run = Bun.spawnSync(["git", ...args]);
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

function releases(): Release[] {
  const run = Bun.spawnSync(["gh", "release", "list", "--limit", "200", "--json", "tagName,isDraft,isPrerelease"]);
  if (run.exitCode !== 0) throw new Error(`gh release list failed: ${run.stderr.toString().trim()}`);
  return JSON.parse(run.stdout.toString());
}

if (import.meta.main) {
  const env = process.env;
  try {
    const classification = JSON.parse(env.CLASSIFICATION ?? "") as Classification;
    const alpha = classification.path === "cli-alpha" || classification.path === "alpha";
    const plan = planRelease({
      classification,
      pkgVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
      tags: alpha ? git(["tag", "--list"]).split("\n").filter(Boolean) : [],
      releases: classification.path === "cli-alpha" && env.PUBLISHABLE === "true" ? releases() : [],
      publishable: env.PUBLISHABLE === "true",
      enginePrerelease: env.ENGINE_PRERELEASE || undefined,
    });
    process.stdout.write(
      `version=${plan.version}\ntag=${plan.tag}\nengine_version=${plan.engineVersion}\npublish=${plan.publish}\nprevious=${plan.previous}\n`,
    );
    console.error(plan.publish ? `Plan: publish ${plan.version} resolving Engine v${plan.engineVersion}.` : "Plan: nothing to publish.");
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

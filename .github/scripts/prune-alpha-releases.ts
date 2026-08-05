#!/usr/bin/env bun
/**
 * Decide which alpha Releases have aged out.
 *
 * Releases only — the tag stays, which is what keeps a published version identifier from
 * ever being reissued and what the next derivation counts (#685). Stable and beta releases
 * are never candidates, whatever their age.
 */
import { isEngineAlphaTag } from "./release-tags.mjs";

export const RETENTION_DAYS = 30;

export type Release = { tagName: string; publishedAt: string | null; isDraft: boolean };

export function prunable(releases: Release[], now: Date): string[] {
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const aged: string[] = [];

  for (const release of releases) {
    if (!isEngineAlphaTag(release.tagName)) continue;
    // Absent rather than false would read as "not a draft" and select a draft for deletion.
    if (typeof release.isDraft !== "boolean") {
      throw new Error(`release ${release.tagName} has no isDraft flag to judge it by`);
    }
    if (release.isDraft || release.publishedAt === null) continue;

    const published = Date.parse(release.publishedAt);
    if (Number.isNaN(published)) {
      throw new Error(`release ${release.tagName} has an unparsable publishedAt: ${release.publishedAt}`);
    }
    if (published < cutoff) aged.push(release.tagName);
  }

  return aged;
}

if (import.meta.main) {
  const releases: Release[] = JSON.parse(await Bun.stdin.text());
  for (const tag of prunable(releases, new Date())) console.log(tag);
}

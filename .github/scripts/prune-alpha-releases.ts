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

export function prunable(releases: Release[], now: Date, days = RETENTION_DAYS): string[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return releases
    .filter((r) => isEngineAlphaTag(r.tagName))
    .filter((r) => {
      // Absent rather than false would read as "not a draft" and select a draft for deletion.
      if (typeof r.isDraft !== "boolean") {
        throw new Error(`release ${r.tagName} has no isDraft flag to judge it by`);
      }
      return !r.isDraft && r.publishedAt !== null;
    })
    .filter((r) => {
      const published = Date.parse(r.publishedAt as string);
      if (Number.isNaN(published)) {
        throw new Error(`release ${r.tagName} has an unparsable publishedAt: ${r.publishedAt}`);
      }
      return published < cutoff;
    })
    .map((r) => r.tagName);
}

if (import.meta.main) {
  const raw = await Bun.stdin.text();
  const releases: Release[] = JSON.parse(raw);
  const now = process.env.PRUNE_NOW ? new Date(process.env.PRUNE_NOW) : new Date();
  for (const tag of prunable(releases, now)) console.log(tag);
}

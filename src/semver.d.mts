// The module stays .mjs because the npm-publish and homebrew workflows run their scripts
// under node, which cannot import a .ts module.
export type SemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
};

export function tryParseSemver(raw: unknown): SemVer | null;
export function parseSemver(raw: unknown, label: string): SemVer;
export function isSemver(raw: unknown): boolean;
export function isStableVersion(raw: unknown): boolean;
export function cmp(a: SemVer, b: SemVer): number;
export function fmt(v: SemVer): string;

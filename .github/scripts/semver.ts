/**
 * SemVer parsing and precedence, shared by the version drift gate and the alpha
 * version derivation — both must agree on "a stable version outranks its prereleases",
 * or a derived alpha could pass one and fail the other (#685).
 */

export type SemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function parseSemver(raw: string, label: string): SemVer {
  const m = raw.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  );
  if (!m) {
    throw new Error(`${label}: not a valid x.y.z semver (got '${raw}')`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4]?.split(".") ?? [],
  };
}

export function cmp(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // SemVer precedence: a stable version outranks its prereleases.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;

    const an = ai.match(/^(0|[1-9]\d*)$/);
    const bn = bi.match(/^(0|[1-9]\d*)$/);
    if (an && bn) return Number(ai) - Number(bi);
    if (an) return -1;
    if (bn) return 1;
    return ai < bi ? -1 : 1;
  }

  return 0;
}

export function fmt(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length ? `${base}-${v.prerelease.join(".")}` : base;
}

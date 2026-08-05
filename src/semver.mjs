/**
 * SemVer 2.0 — the one place in this repo that knows the grammar.
 *
 * `kesha install --engine-version`, the version drift gate, the alpha derivation, the npm
 * dist-tag resolver, the package.json writer and the Linux package names all decide "is this
 * a version" or "which is newer". Separate copies disagree at the edges: `derive-alpha-version`
 * asserts its output sorts above the pin that `check-versions` later validates, so one parser
 * accepting what another refuses is a release that passes derivation and fails the gate
 * (#685, #738).
 *
 * Stays `.mjs`: npm-publish.yml, release-npm-publish.yml and homebrew-tap.yml run their
 * scripts under node, which cannot import a `.ts` module. Types live in `semver.d.mts`.
 *
 * The release *tag* grammar is deliberately not here — `.github/scripts/release-tags.mjs`
 * keeps it as a POSIX ERE string so bash `=~` and JavaScript consume identical text.
 */

/** The pattern published with the SemVer 2.0 spec; a looser one accepts `1.0.0-01` and `01.2.3`. */
const SEMVER_2_0 =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The only place the pattern is applied; everything else here builds on this. */
export function tryParseSemver(raw) {
  const m = typeof raw === "string" ? raw.match(SEMVER_2_0) : null;
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4]?.split(".") ?? [],
    build: m[5]?.split(".") ?? [],
  };
}

export function parseSemver(raw, label) {
  const parsed = tryParseSemver(raw);
  if (!parsed) {
    throw new Error(`${label}: not a valid SemVer 2.0 version (got '${raw}')`);
  }
  return parsed;
}

export function isSemver(raw) {
  return tryParseSemver(raw) !== null;
}

/** A version fit for a release tag or a package filename: no prerelease, no build metadata. */
export function isStableVersion(raw) {
  const parsed = tryParseSemver(raw);
  return parsed !== null && parsed.prerelease.length === 0 && parsed.build.length === 0;
}

/** SemVer §10: build metadata is ignored when determining precedence. */
export function cmp(a, b) {
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

export function fmt(v) {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  const withPre = v.prerelease.length ? `${base}-${v.prerelease.join(".")}` : base;
  return v.build.length ? `${withPre}+${v.build.join(".")}` : withPre;
}

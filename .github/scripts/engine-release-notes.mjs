#!/usr/bin/env node
/**
 * The release body for a tag: the tag's own notes, then how to verify the assets.
 *
 * The notes half goes through the annotation gate — an unguarded `%(contents)` publishes the
 * commit message when the tag is lightweight (#815). The verification half is unconditional:
 * it is what a downloader needs, and it does not depend on anyone having authored anything.
 */
import { isEntry } from "./script-entry.mjs";
import { readTagNotes } from "./tag-notes.mjs";

const REPO = "drakulavich/kesha-voice-kit";

// One SHA256SUMS also lists the .deb/.rpm, which the download pattern leaves out, hence --ignore-missing.
function verifySection(tag, ref) {
  return `### Verify release assets

Download the published binaries and checksums, then verify them:

\`\`\`bash
gh release download ${tag} -p SHA256SUMS -p kesha-release-manifest.json -p '*.sigstore.json' -p 'kesha-*' -p 'say-*'
sha256sum -c --ignore-missing SHA256SUMS

cosign verify-blob \\
  --bundle kesha-engine-darwin-arm64.sigstore.json \\
  --certificate-identity "https://github.com/${REPO}/.github/workflows/release.yml@${ref}" \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \\
  kesha-engine-darwin-arm64
\`\`\`

The release also includes packaging metadata in \`kesha-release-manifest.json\`
and a source SBOM in \`kesha-voice-kit-${tag}.spdx.json\`.
`;
}

/** `ref` is what the run was signed under: the tag for a tag push, the branch for a dispatch that creates its tag at publish. */
export function composeEngineReleaseNotes(tag, notes, ref = `refs/tags/${tag}`) {
  const authored = notes?.trim();
  return authored ? `${authored}\n\n${verifySection(tag, ref)}` : verifySection(tag, ref);
}

function main() {
  const tag = process.env.TAG_NAME;
  if (!tag) {
    console.error("usage: TAG_NAME=… node .github/scripts/engine-release-notes.mjs > release-notes.md");
    process.exit(2);
  }
  process.stdout.write(composeEngineReleaseNotes(tag, readTagNotes(tag), process.env.SIGNING_REF || undefined));
}

if (isEntry(import.meta.url)) main();

#!/usr/bin/env node
/**
 * The draft release body for an engine tag: the tag's own notes, then how to verify the assets.
 *
 * The notes half goes through the annotation gate — an unguarded `%(contents)` publishes the
 * commit message when the tag is lightweight (#815). The verification half is unconditional:
 * it is what a downloader needs, and it does not depend on anyone having authored anything.
 */
import { isEntry } from "./script-entry.mjs";
import { readTagNotes } from "./tag-notes.mjs";

const REPO = "drakulavich/kesha-voice-kit";

const DRAFT_SMOKE = `

# Before gh release edit --draft=false, require the authenticated install smoke to pass:
gh workflow run release-install-smoke.yml -R ${REPO} -f tag=TAG -f mode=draft-engine`;

const DRAFT_SMOKE_NOTE = `
The smoke downloads this draft with GitHub authentication into an isolated cache, checks the
Linux artifact's version and capabilities, warms ASR, then transcribes and synthesises. If it
fails, do not un-draft; inspect its log and rebuild or replace the draft with a new patch tag.
`;

/** release.yml smokes the artifacts before publishing and leaves no draft, so its notes carry no draft step. */
function verifySection(tag, workflow) {
  const drafted = workflow === "build-engine.yml";
  return `### Verify release assets

Download the published binaries and checksums, then verify them:

\`\`\`bash
gh release download ${tag} -p SHA256SUMS -p kesha-release-manifest.json -p '*.sigstore.json' -p 'kesha-*' -p 'say-*'
sha256sum -c ${drafted ? "" : "--ignore-missing "}SHA256SUMS

cosign verify-blob \\
  --bundle kesha-engine-darwin-arm64.sigstore.json \\
  --certificate-identity "https://github.com/${REPO}/.github/workflows/${workflow}@refs/tags/${tag}" \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \\
  kesha-engine-darwin-arm64${drafted ? DRAFT_SMOKE.replace("TAG", tag) : ""}
\`\`\`

The release also includes packaging metadata in \`kesha-release-manifest.json\`
and a source SBOM in \`kesha-voice-kit-${tag}.spdx.json\`.
${drafted ? DRAFT_SMOKE_NOTE : ""}`;
}

export function composeEngineReleaseNotes(tag, notes, workflow = "build-engine.yml") {
  const authored = notes?.trim();
  return authored ? `${authored}\n\n${verifySection(tag, workflow)}` : verifySection(tag, workflow);
}

function main() {
  const tag = process.env.TAG_NAME;
  if (!tag) {
    console.error("usage: TAG_NAME=… node .github/scripts/engine-release-notes.mjs > release-notes.md");
    process.exit(2);
  }
  process.stdout.write(composeEngineReleaseNotes(tag, readTagNotes(tag), process.env.RELEASE_WORKFLOW));
}

if (isEntry(import.meta.url)) main();

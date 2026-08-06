#!/usr/bin/env node
/**
 * Refuse to name a Linux package after a CLI version npm never published.
 *
 * Until #727 a stable engine tag had to equal `package.json#version`, which incidentally kept
 * the `.deb`/`.rpm` filename tied to a released CLI. Dropping that assertion (it made the engine
 * answer to the CLI's version line) left nothing comparing the two, and `main` has carried the
 * next *unreleased* CLI version since #691 — so the next stable engine cut would attach
 * `kesha-voice-kit_1.27.0-1_amd64.deb` for a CLI that is not on npm (#728).
 *
 * Run via `node .github/scripts/assert-npm-published.mjs [version]`; silent on success.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REGISTRY_URL = "https://registry.npmjs.org/@drakulavich%2Fkesha-voice-kit";

/** Abbreviated packument: the same version list in ~68KB instead of ~2MB. */
const ABBREVIATED = "application/vnd.npm.install-v1+json";

/** A stalled connection would otherwise hold the release job open to its own outer timeout. */
const TIMEOUT_MS = 15_000;

export const E_REGISTRY_UNREACHABLE = "E_REGISTRY_UNREACHABLE";
export const E_VERSION_UNPUBLISHED = "E_VERSION_UNPUBLISHED";

/** A registry we could not read proves nothing, so it must never read as "version absent". */
function unreachable(detail, cause) {
  const error = new Error(
    `cannot verify the packaged CLI version against npm: ${detail}. ` +
      "Re-run once the registry answers; do not attach Linux packages on an unverified version (#728).",
    cause ? { cause } : undefined,
  );
  error.code = E_REGISTRY_UNREACHABLE;
  return error;
}

const aborted = (error) => error?.name === "TimeoutError" || error?.name === "AbortError";

async function fetchPublished(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(REGISTRY_URL, {
      headers: { accept: ABBREVIATED },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw unreachable(
      aborted(cause)
        ? `${REGISTRY_URL} did not answer within ${TIMEOUT_MS / 1000}s`
        : `${REGISTRY_URL} could not be reached (${cause?.message ?? cause})`,
      cause,
    );
  }
  if (!response.ok) {
    throw unreachable(`${REGISTRY_URL} answered HTTP ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw unreachable(`${REGISTRY_URL} answered a body that is not JSON`, cause);
  }

  const versions = Object.keys(body?.versions ?? {});
  if (versions.length === 0) {
    throw unreachable(`${REGISTRY_URL} listed no published versions`);
  }
  return { versions, latest: body?.["dist-tags"]?.latest };
}

export async function assertNpmPublished(version, fetchImpl = fetch) {
  const { versions, latest } = await fetchPublished(fetchImpl);
  if (versions.includes(version)) return;

  const error = new Error(
    `package.json#version ${version} was never published to npm (latest is ${latest ?? "unknown"}), ` +
      `so this release would attach Linux packages named for a CLI nobody can install. ` +
      `Publish the CLI first (tag v${version}-cli) or cut the engine from a commit whose version is on npm (#728).`,
  );
  error.code = E_VERSION_UNPUBLISHED;
  throw error;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const version = process.argv[2] ?? JSON.parse(readFileSync("package.json", "utf8")).version;
  try {
    await assertNpmPublished(version);
  } catch (error) {
    console.error(`${error.code ?? "E_UNEXPECTED"}: ${error.message}`);
    process.exit(1);
  }
}

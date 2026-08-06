// The module stays .mjs because build-engine.yml runs it under node, not bun.
export const REGISTRY_URL: string;
export const E_REGISTRY_UNREACHABLE: "E_REGISTRY_UNREACHABLE";
export const E_VERSION_UNPUBLISHED: "E_VERSION_UNPUBLISHED";
export function assertNpmPublished(
  version: string,
  fetchImpl?: (
    url: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
  ) => Promise<Response>,
): Promise<void>;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export function sha256ForUrl(url: string, fetchImpl?: FetchImpl): Promise<string>;
export function versionForTag(tag: string, fetchImpl?: FetchImpl): Promise<string>;
export function buildUpdatedFormula(args: {
  tag: string;
  formula: string;
  fetchImpl?: FetchImpl;
}): Promise<string>;

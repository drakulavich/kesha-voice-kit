// Preloaded by raycast-lint.sh: any live raycast.com call must fail the lane every time, not only when raycast.com flakes (#1292, #1311).
const http = require("node:http");
const https = require("node:https");

function refuse(target, scheme) {
  const url =
    typeof target === "string" || target instanceof URL
      ? new URL(target)
      : target && typeof target.url === "string"
        ? new URL(target.url)
        : new URL(`${scheme}//${target?.hostname ?? target?.host ?? "localhost"}${target?.path ?? "/"}`);
  const host = url.hostname.replace(/\.$/, "");
  if (host === "raycast.com" || host.endsWith(".raycast.com")) {
    return new Error(`blocked live fetch of ${url.href}; raycast-lint.sh must pass the vendored schema and the stubbed RAY_APIURL`);
  }
}

for (const [mod, scheme] of [[http, "http:"], [https, "https:"]]) {
  for (const name of ["request", "get"]) {
    const original = mod[name];
    mod[name] = function (target, ...rest) {
      const error = refuse(target, scheme);
      if (error) throw error;
      return original.call(this, target, ...rest);
    };
  }
}

const fetch = globalThis.fetch;
globalThis.fetch = function (target, ...rest) {
  const error = refuse(target, "https:");
  return error ? Promise.reject(error) : fetch.call(this, target, ...rest);
};

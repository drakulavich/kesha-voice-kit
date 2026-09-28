// Preloaded by raycast-lint.sh: a live schema fetch must fail the lane every time, not only when raycast.com flakes (#1292).
const https = require("node:https");

const request = https.request;
https.request = function (target, ...rest) {
  const url = target instanceof URL ? target : new URL(typeof target === "string" ? target : `https://${target.hostname ?? target.host}${target.path ?? target.pathname ?? "/"}`);
  if (url.hostname === "www.raycast.com" && url.pathname.startsWith("/schemas/")) {
    throw new Error(`blocked live schema fetch of ${url.href}; raycast-lint.sh must pass the vendored schema`);
  }
  return request.call(this, target, ...rest);
};

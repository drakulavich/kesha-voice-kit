// Preloaded by raycast-lint.sh: any live raycast.com call must fail the lane every time, not only when raycast.com flakes (#1292, #1311).
const https = require("node:https");

const request = https.request;
https.request = function (target, ...rest) {
  const url = target instanceof URL ? target : new URL(typeof target === "string" ? target : `https://${target.hostname ?? target.host}${target.path ?? target.pathname ?? "/"}`);
  if (url.hostname === "www.raycast.com") {
    throw new Error(`blocked live fetch of ${url.href}; raycast-lint.sh must pass the vendored schema and the stubbed RAY_APIURL`);
  }
  return request.call(this, target, ...rest);
};

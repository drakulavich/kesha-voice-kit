import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "../../.github/scripts/raycast-no-live-fetch.cjs");
const URL_ = "https://www.raycast.com/api/v1/users/x";

const PROBES: Record<string, string> = {
  fetch: `const c = new AbortController(); const p = fetch(u, { signal: c.signal }); c.abort(); await p;`,
  "http.request": `require("node:http").request(u.replace("https:", "http:")).destroy();`,
  "http.get": `require("node:http").get(u.replace("https:", "http:")).destroy();`,
  "https.request": `require("node:https").request(u).destroy();`,
  "https.get": `require("node:https").get(new URL(u)).destroy();`,
  "https.request with options": `require("node:https").request({ hostname: "www.raycast.com", path: "/api/v1/users/x" }).destroy();`,
};

async function probe(call: string) {
  const script = `const u = ${JSON.stringify(URL_)}; (async () => { try { ${call} console.log("not blocked"); } catch (e) { console.log(e.message); } })();`;
  const proc = Bun.spawn(["node", "--require", GUARD, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

describe("raycast-no-live-fetch.cjs", () => {
  for (const [transport, call] of Object.entries(PROBES)) {
    test(`blocks raycast.com through ${transport}`, async () => {
      expect(await probe(call)).toContain("blocked live fetch of http");
    });
  }

  test("lets other hosts through", async () => {
    expect(await probe(`require("node:https").request("https://example.invalid/").destroy();`)).toBe("not blocked");
  });
});

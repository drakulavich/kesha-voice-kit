#!/usr/bin/env bun
// Load-bearing: on a version mismatch `downloadEngine` fetches the published engine instead of the one staged at KESHA_ENGINE_BIN.
const pkg = await Bun.file("package.json").json();
await Bun.write(`${process.env.KESHA_ENGINE_BIN}.version`, `${pkg.keshaEngine.version}\n`);

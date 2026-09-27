#!/usr/bin/env bun
// Load-bearing: on a version mismatch `installEngine` fetches the published engine instead of the one staged at KESHA_ENGINE_BIN.
import { engineVersion } from "../../src/package-info";

await Bun.write(`${process.env.KESHA_ENGINE_BIN}.version`, `${engineVersion}\n`);

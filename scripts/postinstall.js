#!/usr/bin/env node
const { execSync } = require("child_process");

try {
  execSync("bun --version", { stdio: "ignore" });
} catch {
  console.warn(
    "\n⚠️  Kesha Voice Kit requires Bun runtime.\n" +
    "   Install Bun: curl -fsSL https://bun.sh/install | bash\n" +
    "   Then run:    kesha install\n"
  );
}

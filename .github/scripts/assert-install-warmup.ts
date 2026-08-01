#!/usr/bin/env bun
/**
 * The ASR warm-up is deliberately non-fatal (`rust/src/cli/install.rs`, #298):
 * install already succeeded, so a failed warm-up only warns and the first real
 * run pays the cold start. That means a green `kesha install` is NOT evidence
 * the ORT session initialises — on a platform whose runtime behaviour is what
 * we are trying to establish, that distinction is the whole point.
 *
 * Usage: bun .github/scripts/assert-install-warmup.ts <install-log>
 */
const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: assert-install-warmup.ts <install-log>");
  process.exit(2);
}

const log = await Bun.file(logPath).text();

if (/ASR backend warm-up failed/.test(log)) {
  console.error(
    "FAIL: install reported success but the ASR warm-up failed — the engine cannot " +
      "initialise an ORT session on this platform.\n" +
      log.split("\n").filter((l) => /warm/i.test(l)).join("\n"),
  );
  process.exit(1);
}

if (!/ASR backend warmed up/.test(log)) {
  console.error(
    "FAIL: no warm-up outcome in the install log. Either warm-up was skipped " +
      "(--no-warmup) or the log was not captured — both leave the platform unverified.",
  );
  process.exit(1);
}

console.log("ok: ASR backend warmed up during install");

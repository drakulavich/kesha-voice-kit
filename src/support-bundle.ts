import { mkdirSync, statSync, writeFileSync } from "fs";
import { basename, dirname, resolve } from "path";
import { gzipSync } from "node:zlib";
import { collectDoctorReport, formatDoctorReport } from "./doctor";
import { readDiagnosticLogTail } from "./diagnostic-log";
import { KeshaError } from "./engine/events";
import { errorMessage } from "./error-utils";
import { PATH_ERRNOS } from "./path-errnos";

interface SupportBundleOptions {
  output?: string;
  redact?: boolean;
  now?: Date;
  includeLogs?: boolean;
}

export interface SupportBundleResult {
  path: string;
  sizeBytes: number;
  entries: string[];
}

interface TarEntry {
  name: string;
  data: Uint8Array;
}

const TAR_BLOCK_SIZE = 512;
const textEncoder = new TextEncoder();

function supportBundleTimestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

function defaultBundlePath(now: Date): string {
  return resolve(`kesha-support-bundle-${supportBundleTimestamp(now)}.tar.gz`);
}

function encodeUtf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const data = encodeUtf8(value);
  if (data.byteLength > length) {
    throw new Error(`tar field is too long: ${value}`);
  }
  target.set(data, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = value.toString(8);
  if (encoded.length > length - 1) {
    throw new Error(`tar numeric field is too large: ${value}`);
  }
  writeAscii(target, offset, length, `${encoded.padStart(length - 1, "0")}\0`);
}

function padLength(size: number): number {
  const remainder = size % TAR_BLOCK_SIZE;
  return remainder === 0 ? 0 : TAR_BLOCK_SIZE - remainder;
}

function createTarHeader(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  writeAscii(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeAscii(header, 156, 1, "0");
  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function createTarArchive(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let totalBytes = TAR_BLOCK_SIZE * 2;

  for (const entry of entries) {
    const padding = new Uint8Array(padLength(entry.data.byteLength));
    const header = createTarHeader(entry);
    chunks.push(header, entry.data, padding);
    totalBytes += header.byteLength + entry.data.byteLength + padding.byteLength;
  }

  chunks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));

  const archive = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

function fileInTheWay(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    try {
      return statSync(d).isDirectory() ? null : d;
    } catch {
      if (dirname(d) === d) return null;
    }
  }
}

function bundleWriteFailure(outputPath: string, e: unknown): unknown {
  const dir = dirname(outputPath);
  const errno = (e as NodeJS.ErrnoException).code ?? "";
  const blocker = fileInTheWay(dir);
  if (blocker) {
    return new KeshaError("E_INVALID_ARG", `Cannot write the support bundle to ${outputPath}: ${blocker} is a file, not a directory`, {
      hint: `remove or rename the file blocking ${blocker}, or pass --output a path under a directory.`,
    });
  }
  const why = PATH_ERRNOS[errno];
  if (why) {
    return new KeshaError("E_INVALID_ARG", `Cannot write the support bundle to ${outputPath}: ${why} (${errno})`, {
      hint: `pass --output a path in a directory you can write to.`,
    });
  }
  if (!errno) return e;
  if (errno === "ENOSPC") {
    return new KeshaError("E_INTERNAL", `Cannot write the support bundle to ${outputPath}: no space left on its disk (ENOSPC)`, {
      hint: `the disk is full: free space on the volume that holds ${dir}, or pass --output a path on another disk.`,
    });
  }
  return new KeshaError("E_INTERNAL", `Cannot write the support bundle to ${outputPath}: ${errorMessage(e)}`, {
    hint: `resolve that filesystem error on ${dir}, or pass --output a path elsewhere.`,
  });
}

export async function createSupportBundle(
  options: SupportBundleOptions = {},
): Promise<SupportBundleResult> {
  const now = options.now ?? new Date();
  const outputPath = resolve(options.output ?? defaultBundlePath(now));
  const redact = options.redact ?? true;
  const report = await collectDoctorReport({ redact });
  const root = basename(outputPath).replace(/\.tar\.gz$/, "");
  const diagnosticLogTail = options.includeLogs ? readDiagnosticLogTail() : null;
  const diagnosticLogTailData = diagnosticLogTail ? encodeUtf8(diagnosticLogTail.contents) : null;
  const diagnosticLogEntries = diagnosticLogTail
    ? [
        "diagnostic-logs/README.txt",
        "diagnostic-logs/kesha.ndjson",
        "diagnostic-logs/status.json",
      ]
    : [];

  const manifest = {
    generatedAt: report.generatedAt,
    redacted: report.redacted,
    package: report.package,
    format: "tar.gz",
    entries: [
      "README.txt",
      "doctor.json",
      "doctor.txt",
      "manifest.json",
      ...diagnosticLogEntries,
    ],
    diagnosticLogs: diagnosticLogTail
      ? {
          included: true,
          activeSizeBytes: diagnosticLogTail.sizeBytes,
          tailBytes: diagnosticLogTailData?.byteLength ?? 0,
          truncated: diagnosticLogTail.truncated,
        }
      : { included: false },
  };

  const readme =
    "Kesha support bundle\n" +
    "\n" +
    "This archive is generated by `kesha support-bundle`.\n" +
    "It contains redacted diagnostics by default and does not include audio, transcripts, model files, or the Stats database.\n" +
    "Diagnostic log contents are included only when `--include-logs` is passed; included logs are bounded to a sanitized NDJSON tail.\n" +
    "Attach the archive to a GitHub issue when asking for install, cache, engine, or runtime support.\n";

  const files: TarEntry[] = [
    { name: `${root}/README.txt`, data: encodeUtf8(readme) },
    { name: `${root}/doctor.json`, data: encodeUtf8(`${JSON.stringify(report, null, 2)}\n`) },
    { name: `${root}/doctor.txt`, data: encodeUtf8(formatDoctorReport(report)) },
    { name: `${root}/manifest.json`, data: encodeUtf8(`${JSON.stringify(manifest, null, 2)}\n`) },
  ];
  if (diagnosticLogTail) {
    files.push(
      {
        name: `${root}/diagnostic-logs/README.txt`,
        data: encodeUtf8(
          "Kesha diagnostic log tail\n\n" +
            "Included because `kesha support-bundle --include-logs` was used.\n" +
            "The NDJSON tail is bounded and generated by Kesha's diagnostic-log allowlist.\n",
        ),
      },
      {
        name: `${root}/diagnostic-logs/kesha.ndjson`,
        data: diagnosticLogTailData ?? new Uint8Array(),
      },
      {
        name: `${root}/diagnostic-logs/status.json`,
        data: encodeUtf8(
          `${JSON.stringify({
            activeSizeBytes: diagnosticLogTail.sizeBytes,
            tailBytes: diagnosticLogTailData?.byteLength ?? 0,
            truncated: diagnosticLogTail.truncated,
          }, null, 2)}\n`,
        ),
      },
    );
  }

  const archive = gzipSync(createTarArchive(files));
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, archive);
  } catch (e) {
    throw bundleWriteFailure(outputPath, e);
  }

  return {
    path: outputPath,
    sizeBytes: archive.byteLength,
    entries: files.map((file) => file.name),
  };
}

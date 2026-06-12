import type { TranscribeErrorRecord, TranscribeJsonOutput, TranscribeResult } from "./types";

export function formatTextOutput(results: TranscribeResult[]): string {
  if (results.length === 1) {
    return results[0].text + "\n";
  }
  return results
    .map((r, i) => (i > 0 ? "\n" : "") + `=== ${r.file} ===\n${r.text}\n`)
    .join("");
}

export function formatVerboseOutput(results: TranscribeResult[]): string {
  return results
    .map((r, i) => {
      const lines: string[] = [];
      if (results.length > 1) {
        if (i > 0) lines.push("");
        lines.push(`=== ${r.file} ===`);
      }
      if (r.audioLanguage) {
        lines.push(`Audio language: ${r.audioLanguage.code} (confidence: ${r.audioLanguage.confidence.toFixed(2)})`);
      }
      const textLang = r.textLanguage ?? (r.lang ? { code: r.lang, confidence: 0 } : null);
      if (textLang) {
        const confStr = textLang.confidence > 0 ? ` (confidence: ${textLang.confidence.toFixed(2)})` : "";
        lines.push(`Text language: ${textLang.code}${confStr}`);
      }
      if (r.sttTimeMs !== undefined) {
        lines.push(`STT time: ${r.sttTimeMs}ms`);
      }
      lines.push("---");
      lines.push(r.text);
      return lines.join("\n");
    })
    .join("\n") + "\n";
}

export function formatTranscriptOutput(results: TranscribeResult[]): string {
  return results
    .map((r, i) => {
      const lines: string[] = [];
      if (results.length > 1) {
        if (i > 0) lines.push("");
        lines.push(`=== ${r.file} ===`);
      }
      lines.push(r.text);
      const lang = r.textLanguage?.code || r.audioLanguage?.code || r.lang;
      const confidence = r.textLanguage?.confidence ?? r.audioLanguage?.confidence;
      if (lang) lines.push(`[lang: ${lang}${confidence != null ? `, confidence: ${confidence.toFixed(2)}` : ""}]`);
      return lines.join("\n");
    })
    .join("\n") + "\n";
}

export function formatJsonOutput(
  results: TranscribeResult[],
  errors?: TranscribeErrorRecord[],
): string {
  const payload: TranscribeJsonOutput =
    errors === undefined ? results : { results, errors };
  return JSON.stringify(payload, null, 2) + "\n";
}

/** Render a byte count as a human-readable size (e.g. "1.5 MB"). */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

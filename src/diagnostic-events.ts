export function diagnosticSizeBucket(sizeBytes: number | null | undefined): string {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes)) return "unknown";
  if (sizeBytes < 1024 * 1024) return "lt1MB";
  if (sizeBytes < 10 * 1024 * 1024) return "mb1_10";
  if (sizeBytes < 100 * 1024 * 1024) return "mb10_100";
  return "mb100_plus";
}

export function diagnosticCharBucket(chars: number): string {
  if (chars < 100) return "lt100";
  if (chars < 1000) return "c100_1000";
  if (chars < 5000) return "c1000_5000";
  return "c5000_plus";
}

import { describe, expect, test } from "bun:test";
import { diagnosticCharBucket, diagnosticSizeBucket } from "../../src/diagnostic-events";

describe("diagnostic event buckets", () => {
  test("buckets byte sizes into privacy-safe labels", () => {
    expect(diagnosticSizeBucket(null)).toBe("unknown");
    expect(diagnosticSizeBucket(512)).toBe("lt1MB");
    expect(diagnosticSizeBucket(2 * 1024 * 1024)).toBe("mb1_10");
    expect(diagnosticSizeBucket(20 * 1024 * 1024)).toBe("mb10_100");
    expect(diagnosticSizeBucket(200 * 1024 * 1024)).toBe("mb100_plus");
  });

  test("buckets character counts into privacy-safe labels", () => {
    expect(diagnosticCharBucket(10)).toBe("lt100");
    expect(diagnosticCharBucket(500)).toBe("c100_1000");
    expect(diagnosticCharBucket(2000)).toBe("c1000_5000");
    expect(diagnosticCharBucket(5000)).toBe("c5000_plus");
  });
});

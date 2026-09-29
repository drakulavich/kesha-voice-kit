import { stagingPrefix } from "../../src/progress";

const ERRNO_TEXT: Record<string, string> = {
  ENOSPC: "no space left on device",
  EACCES: "permission denied",
  EROFS: "read-only file system",
  EIO: "input/output error",
};

export const FAULT_MARKER = "failing-writes: injected";

/**
 * Fails writes to `destPath`'s staging file only. ENOSPC and EIO land after the first chunk is on disk,
 * so the staging file really holds a partial download; the others fail at open.
 */
export function failStagingWrites(destPath: string, code: keyof typeof ERRNO_TEXT): { restore(): void; hits(): number } {
  const realFile = Bun.file;
  const prefix = stagingPrefix(destPath);
  let hits = 0;
  const failure = (path: string, syscall: string) => {
    hits++;
    process.stderr.write(`${FAULT_MARKER} ${code}\n`);
    return Object.assign(new Error(`${code}: ${ERRNO_TEXT[code]}, ${syscall} '${path}'`), { code, syscall, path });
  };
  const patched = ((path: string, options?: BlobPropertyBag) => {
    const file = realFile(path, options);
    if (typeof path !== "string" || !path.startsWith(prefix)) return file;
    if (code !== "ENOSPC" && code !== "EIO") {
      return new Proxy(file, {
        get: (target, key) => (key === "writer" ? () => { throw failure(path, "open"); } : Reflect.get(target, key)),
      });
    }
    return new Proxy(file, {
      get: (target, key) => {
        if (key !== "writer") return Reflect.get(target, key);
        return () => {
          const sink = target.writer();
          return {
            write(chunk: Uint8Array) {
              sink.write(chunk);
              throw failure(path, "write");
            },
            flush: () => sink.flush(),
            end: () => sink.end(),
          };
        };
      },
    });
  }) as typeof Bun.file;
  (Bun as { file: typeof Bun.file }).file = patched;
  return {
    restore: () => {
      (Bun as { file: typeof Bun.file }).file = realFile;
    },
    hits: () => hits,
  };
}

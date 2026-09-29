const ERRNO_TEXT: Record<string, string> = {
  ENOSPC: "no space left on device",
  EACCES: "permission denied",
  EROFS: "read-only file system",
  EIO: "input/output error",
};

/** The disk failure lands after the first chunk is on disk, so the staging file really holds a partial download. */
export function failEngineStagingWrites(code: keyof typeof ERRNO_TEXT): () => void {
  const realFile = Bun.file;
  const patched = ((path: string, options?: BlobPropertyBag) => {
    const file = realFile(path, options);
    if (!String(path).includes("kesha-engine.part.")) return file;
    const failure = (syscall: string) =>
      Object.assign(new Error(`${code}: ${ERRNO_TEXT[code]}, ${syscall} '${path}'`), { code, syscall, path });
    if (code !== "ENOSPC" && code !== "EIO") {
      return new Proxy(file, {
        get: (target, key) => (key === "writer" ? () => { throw failure("open"); } : Reflect.get(target, key)),
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
              throw failure("write");
            },
            flush: () => sink.flush(),
            end: () => sink.end(),
          };
        };
      },
    });
  }) as typeof Bun.file;
  (Bun as { file: typeof Bun.file }).file = patched;
  return () => {
    (Bun as { file: typeof Bun.file }).file = realFile;
  };
}

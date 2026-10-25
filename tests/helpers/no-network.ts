// Preloaded into a CLI run under test so an install it starts fails at its first request instead of downloading.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network is off in this test: ${String(input)}`);
}) as unknown as typeof fetch;

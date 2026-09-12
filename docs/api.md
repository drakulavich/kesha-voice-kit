# Programmatic API

Kesha exports a small TypeScript API from `@drakulavich/kesha-voice-kit/core` for
use inside a Bun program (the engine still runs as a local subprocess).

```typescript
import { transcribe, downloadModel } from "@drakulavich/kesha-voice-kit/core";

await downloadModel();                       // install engine + models
const text = await transcribe("audio.ogg");  // transcribe
```

The speech API is `transcribe`, `transcribeWithTimestamps` (alias
`transcribeWithSegments`), `say`, `downloadModel`, `downloadTts`, `toToon`,
`KeshaError` and `SayError`; the full surface, including the exported option and
result types, `downloadCoreML` and `hasErrorRecords`, is typed in
[`src/lib.ts`](../src/lib.ts). The engine's describe document is not exported. Same no-auto-download contract as the
CLI: call the install helper explicitly before transcribing or synthesizing.

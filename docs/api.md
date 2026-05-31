# Programmatic API

Kesha exports a small TypeScript API from `@drakulavich/kesha-voice-kit/core` for
use inside a Bun program (the engine still runs as a local subprocess).

```typescript
import { transcribe, downloadModel } from "@drakulavich/kesha-voice-kit/core";

await downloadModel();                       // install engine + models
const text = await transcribe("audio.ogg");  // transcribe
```

The full export surface (including `getEngineCapabilities` and the TTS helpers)
is typed in [`src/lib.ts`](../src/lib.ts). Same no-auto-download contract as the
CLI: call the install helper explicitly before transcribing or synthesizing.

# raycast/ — Raycast extension

Raycast-ecosystem directory: the repo-wide bun rules do NOT apply here.

- **npm, not bun**: `npm ci`, `npm test` (vitest), `npm run lint` (`ray lint`, includes `tsc --noEmit`). CI runs exactly these in the `raycast-lint` job on Node 26. User-facing text about installing the kesha CLI itself still says bun.
- **Upstream mirror**: this extension is synced with `raycast/extensions` (merged as raycast/extensions#29681). Every diff here enlarges the next sync — keep changes focused, no drive-by refactors.
- **Testability convention**: modules take an optional trailing `deps` object for side effects (`spawn`, `kill`, timers, fs); `DictationControllerDeps` carries side effects only — pure helpers are imported directly, never injected. `tests/helpers/fake-process.ts` fakes child processes.
- **UI stays thin**: `dictate-to-clipboard.tsx` only renders `DictationState`; logic lives in `src/lib/` where vitest can reach it without `@raycast/api`.

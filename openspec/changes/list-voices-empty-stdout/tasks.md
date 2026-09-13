## 1. Engine

- [ ] 1.1 `list_voices_empty_on_fresh_cache` asserts empty stdout and a `progress` event on stderr carrying the `kesha install --tts` hint; red on the shipped branch
- [ ] 1.2 The empty-list branch in `rust/src/cli/say.rs` emits `events::progress` and prints nothing to stdout

## 2. Spec

- [ ] 2.1 Sync this delta into `openspec/specs/tts-synthesis/spec.md` and archive the change after the PR merges

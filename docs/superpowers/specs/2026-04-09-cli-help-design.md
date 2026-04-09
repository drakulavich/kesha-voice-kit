# CLI Help Improvements with citty

**Date**: 2026-04-09
**Status**: Approved
**Scope**: `src/cli.ts` rewrite, new `src/__tests__/cli.test.ts`, `package.json` (add citty), `README.md` (license section)

## Problem

The CLI has minimal help output (two lines), no `--help` flag, and no subcommand help. Users have no discoverability for available commands and options. Also, only one audio file can be transcribed at a time.

## Solution

Rewrite `src/cli.ts` using [citty](https://github.com/unjs/citty) to get structured help, subcommands, and flag parsing. Add multiple file transcription support.

### Target Output

`parakeet --help`:
```
parakeet v0.7.4

Fast local speech-to-text. 25 languages. CoreML on Apple Silicon, ONNX on CPU.

Usage: parakeet [command] [options]

Commands:
  install              download speech-to-text models
  help [command]       display help for command

For more info, run a command with --help:
  parakeet install --help
```

`parakeet install --help`:
```
download speech-to-text models

Usage: parakeet install [options]

Options:
  --coreml     force CoreML backend (macOS arm64)
  --onnx       force ONNX backend
  --no-cache   re-download even if cached
  -h, --help   display help for command
```

`parakeet --version` → `0.7.4`

### Multiple File Transcription

`parakeet file1.ogg file2.mp3` transcribes each file in sequence.

**Single file** — no header, just transcript (preserves current behavior, pipe-friendly):
```
Transcript text here.
```

**Multiple files** — header per file, like `head`:
```
=== file1.ogg ===
Transcript of first file.

=== file2.mp3 ===
Transcript of second file.
```

If any file fails, log the error to stderr and continue. Exit code 1 if any file failed, 0 if all succeeded.

### Output Format

`--json` flag switches output from plain text to JSON.

**Single file, text (default):**
```
Transcript text here.
```

**Single file, JSON (`parakeet --json audio.ogg`):**
```json
[{"file":"audio.ogg","text":"Transcript text here."}]
```

JSON output is always an array, even for a single file — consistent for programmatic consumers.

**Multiple files, text:**
```
=== file1.ogg ===
Transcript of first file.

=== file2.mp3 ===
Transcript of second file.
```

**Multiple files, JSON (`parakeet --json file1.ogg file2.ogg`):**
```json
[{"file":"file1.ogg","text":"Transcript of first file."},{"file":"file2.ogg","text":"Transcript of second file."}]
```

**Error in JSON mode** — failed files include an `error` field instead of `text`:
```json
[{"file":"file1.ogg","text":"Transcript here."},{"file":"bad.ogg","error":"File not found: bad.ogg"}]
```

### Architecture

- **Main command** — `defineCommand` with `meta` (name, version, description), positional `files` arg (variadic), `--json` boolean flag, and `run` handler for transcription
- **`install` subcommand** — `defineCommand` with `--coreml`, `--onnx`, `--no-cache` boolean args
- **`runMain()`** — provides `--help`, `--version`, and subcommand help automatically

Single file: `src/cli.ts`. No changes to `src/lib.ts` or any other source files.

### New Dependency

- `citty` — zero deps, ~15KB, ESM-native

### CLI Tests (`src/__tests__/cli.test.ts`)

Test citty command definitions by importing them:
- `--help` produces expected output (contains "Usage:", command names)
- `--version` prints version string
- `install` subcommand accepts `--coreml`, `--onnx`, `--no-cache`
- `--json` flag is accepted
- Multiple positional args are parsed correctly
- JSON output format for single and multiple files
- No args shows help

### README License Update

Replace current license section with:
```
## License

Made with 💛🩵 Published under MIT License.
```

## Out of Scope

- No changes to `src/lib.ts` public API
- No changes to transcription logic
- No new subcommands beyond `install`

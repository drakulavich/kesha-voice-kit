# Improved ffmpeg Error Messages

**Date**: 2026-04-09
**Status**: Approved
**Scope**: `src/audio.ts` — `assertFfmpegExists()` function only

## Problem

When ffmpeg is not installed, parakeet shows a generic error:
```
ffmpeg not found in PATH
```
This gives the user no guidance on how to fix it, especially across different OSes and package managers.

## Solution

Replace the generic error with an OS-aware message that detects available package managers and suggests the correct install command.

### Detection Logic

The function uses `Bun.which()` to probe for package managers (same pattern already used for ffmpeg itself):

| Platform | Package manager check | Suggested command |
|---|---|---|
| macOS | `brew` | `brew install ffmpeg` |
| macOS | `port` (fallback) | `sudo port install ffmpeg` |
| Linux | `apt` | `sudo apt install ffmpeg` |
| Linux | `dnf` | `sudo dnf install ffmpeg-free` |
| Linux | `pacman` | `sudo pacman -S ffmpeg` |
| Windows | `choco` | `choco install ffmpeg` |
| Windows | `scoop` | `scoop install ffmpeg` |
| Windows | `winget` | `winget install ffmpeg` |
| Any | fallback | `https://ffmpeg.org/download.html` |

### Error Message Format

```
ffmpeg is required but not found in PATH.

Install it:
  brew install ffmpeg
```

Only the first matching package manager is shown (not all of them). If none are found, the fallback URL is shown.

### Implementation

All changes are in `src/audio.ts`:
- `assertFfmpegExists()` calls a new helper `getFfmpegInstallHint(): string`
- `getFfmpegInstallHint()` checks `process.platform` and probes for package managers via `Bun.which()`
- No new files, no new dependencies

## Out of Scope

- No `parakeet install --ffmpeg` auto-installer
- No native WAV handling to bypass ffmpeg
- No new dependencies

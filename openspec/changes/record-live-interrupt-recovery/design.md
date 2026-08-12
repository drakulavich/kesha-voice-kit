# Design — recovering an interrupted `record --live`

## D0. Why two mechanisms and not one

The ticket offers three options: flush what the session has on signal, keep the
audio behind an opt-in flag, or document the loss and move on. The first two are
not alternatives — they cover disjoint failure modes, and each leaves a hole the
other fills.

A signal handler cannot help a process that is never scheduled again. `SIGKILL`,
a panic in the CoreML bridge, a laptop losing power: none of them run any code
of ours. Only something already on disk survives those, which is what the
recovery WAV is.

The recovery WAV alone, meanwhile, turns a total loss into "here is a WAV, run
`kesha` on it" — better, but it throws away a transcript that was sitting in
memory, complete, at the moment the user pressed Ctrl-C. Raycast (#947) cancels
by design, so for its main flow that would be the *common* path, not the
disaster path.

So: finish on signal for the cancellations we can catch, recovery audio for
everything else. The third option — documenting the loss — was rejected because
it makes #947's adoption a trade-off, and the fix is small.

## D1. Why the audio is spilled, not the transcript

The obvious cheaper spill is the transcript-so-far: text is tiny, and a partial
transcript is what the user actually wants. It is not available. The bound
surface has no partials — `streaming_asr_feed` returns `Result<()>` and the
Swift bridge exposes no callback, at 0.14.8 and at 0.15.5 alike (the
`record-live-streaming-asr` D0b finding, unchanged). The only text the session
ever yields comes out of `finish`, which consumes it.

That is precisely why finishing on a signal is the mechanism that gets the
prefix: it is the only way to ask for the text at all.

## D2. Why a growing WAV rather than raw PCM plus a sidecar

A spill is only useful if the user can point `kesha` at it, which means it has
to be a real audio file at every instant, not just at the end. RIFF makes that
awkward — the header carries three sizes that are only known when the recording
stops.

Rewriting those three fields periodically is the standard answer and costs one
seek and 58 bytes per interval. `SYNC_SAMPLES = 16_000` — ~0.33 s at the 48 kHz
a Mac's built-in mic reports — sets the bound on what a `kill -9` costs: a
reader sees every sample up to the last rewrite and none after it, so the loss
is bounded by the interval, not by the length of the recording.

The alternative — raw f32 PCM plus a documented header recipe — is smaller code
but leaves the user holding a file nothing opens. Rejected.

Spilled samples are taken after the mono mixdown and before the session's
resample to 16 kHz, so recovery audio is at the device's native rate and can be
re-transcribed at full fidelity. It costs ~192 KB/s at a 48 kHz device, bounded
by `--max-seconds`.

## D3. Where the spill lives, and when it goes

Under `models::cache_dir().join("recordings")`, so `KESHA_CACHE_DIR` relocates
it with everything else the tool owns, and so a user who has seen `~/.cache/kesha`
once knows where to look. `$TMPDIR` was the other candidate and was rejected for
discoverability: macOS's per-user temp path is unmemorable and swept.

Lifetime is the part that decides whether this is a safety net or a disk leak:

- printed on stderr **at session start**, because a process that gets `SIGKILL`
  cannot tell the user anything afterwards;
- deleted when the session ends normally, which is what keeps the `--live`
  contract "no WAV file left behind" true for the happy path;
- kept, and named again on stderr, when a signal stopped the session or when
  `finish` failed;
- pruned at the next session start once older than seven days, matched by the
  `live-` prefix this writer uses, so an unrecovered spill is not deleted out
  from under a user who is still going to want it.

A spill that cannot be created or written is a warning on stderr and nothing
more. Failing the recording because its safety net broke would be the same bug
in a new place.

## D4. Signal handling kept to an atomic store

The handler stores the signal number in an `AtomicI32` and returns. That is
inside the async-signal-safe subset; everything else — draining the channel,
finishing the FluidAudio session, writing stdout — happens on the normal
control path once the capture loop notices the flag, where it is allowed to
allocate and call into Swift.

The flag is sticky and read twice: once per iteration of the capture loop as a
stop condition, and once after `finish` to decide the exit code and the spill's
fate.

`libc` moved from an optional dependency to an unconditional one so this module
and its test compile in the default feature set. Without that the handler would
only exist under `coreml`, which no CI lane *runs* tests for — the every-PR
macOS and Linux lanes build `--features tts`. The cost is nil: `libc` is already
in the tree through `cpal`, `dirs` and `ureq`.

## D5. Exit codes

`128 + signal` — 130 for SIGINT, 143 for SIGTERM. The transcript is on stdout
either way; the code is what lets a caller tell "the user cancelled" from "the
recording reached its end", which is the distinction Raycast's cancellation path
needs.

That makes the CLI's own rule wrong as written: `recordEngine` threw on any
non-zero exit, which would print `kesha-engine record exited with code 130`
directly beneath a transcript that arrived perfectly. A live run now treats 130
and 143 as success. `--out` installs no handler, so a signalled capture there
really did lose its recording and still reports as a failure.

Documenting the engine's exit codes is #940's job, not this change's.

## D6. What this change deliberately does not touch

- **#952** — the live path feeds an unbounded channel from the realtime callback
  and detaches a stdin thread. The spill writes happen on the draining thread
  next to the existing session feed, never in the CPAL callback, so the realtime
  constraint is unchanged; the channel architecture is left alone.
- **#939** — the CLI force-kills the engine one second after forwarding a
  signal. Finishing a streaming session fits well inside that, but the budget is
  process-tree work. If it were ever exceeded, the recovery WAV is what remains,
  which is the degradation this design is built around.
- **#940** — exit-code documentation.

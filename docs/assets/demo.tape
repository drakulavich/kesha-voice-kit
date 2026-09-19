# kesha README screencast.
#
# Recorded against the Git LFS fixtures in tests/fixtures, never against real voice
# messages. That is the rule, not a convenience: the recording is published, so every
# word in a frame must be a fixture's. Run `git lfs pull` first; without it the .ogg
# files are pointer stubs and the transcribe step fails.
#
# docs/assets/demo.mp4 and docs/assets/demo.webp are plain files in git, not LFS: the
# .gitattributes rules cover docs/assets/*.svg, docs/assets/*.png and *.gif, and neither
# output matches, so a clone needs nothing extra before touching either.
#
# 1. Record the mp4. The `kesha` on PATH must be this checkout, not a globally installed
#    package, so build a throwaway directory whose bin/kesha is a two-line sh wrapper:
#
#      DIR=$(mktemp -d) && mkdir "$DIR/bin"
#      printf '#!/bin/sh\nexec bun run %s/bin/kesha.js "$@"\n' "$PWD" > "$DIR/bin/kesha"
#      chmod +x "$DIR/bin/kesha"
#      PATH="$DIR/bin:$PATH" kesha --version      # must print package.json#version
#      PATH="$DIR/bin:$PATH" vhs docs/assets/demo.tape
#
#    Use vhs 0.11.0. Version 0.12.0 exits 0 and writes no file
#    (https://github.com/charmbracelet/vhs/issues/787). The engine on PATH must be the one
#    package.json#keshaEngine.version pins: an older one prints a text-language warning
#    from its protocol above every transcript. Warm the engine once before recording
#    (one transcribe, one `kesha say`): the first CoreML transcribe and the first Kokoro
#    synthesis each take 15-20 s of model load, and the video should show steady-state
#    latency, which is well under a second for these fixtures.
#
# 2. Build the animated WebP the README shows. This ffmpeg has no libwebp encoder, so
#    the frames go through the libwebp tools; -d 83 is the frame delay in ms at 12 fps.
#    img2webp reads frame options only before the frames they apply to, so -d has to sit
#    ahead of the glob; after it, img2webp warns and silently uses its 100 ms default.
#
#      FRAMES=$(mktemp -d)
#      ffmpeg -i docs/assets/demo.mp4 -vf "fps=12" "$FRAMES/f%04d.png"
#      img2webp -loop 0 -lossy -q 80 -d 83 "$FRAMES"/f*.png -o docs/assets/demo.webp
#
# 3. Budgets: the WebP under 2 MB, the mp4 under 4 MB, the recording under 30 seconds.
#    If the WebP comes out over budget, drop -q to 70 or the rate to fps=10 before you
#    shrink the canvas.
#
# FontSize is 22, which fits about 110 columns in a 1500-pixel frame. The widest thing
# the recording shows is the Russian transcribe command at 68 columns, and the tallest is
# the JSON envelope at 17 lines plus the command and its progress row, which is why the
# frame is 800 pixels high. Never crop.
#
# Ctrl+L before each command starts its output at the top of the frame rather than
# partway down a scrolling screen. hello.wav is written into the working directory and
# is not committed: delete it after recording.

Output docs/assets/demo.mp4

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set Padding 24
Set TypingSpeed 50ms
Set Width 1500
Set Height 800
Set FontSize 22

# 1. orient the viewer
Type "kesha --version"
Sleep 300ms
Enter
Sleep 1s

# 2. the hero: an English voice message in, a transcript with its language tail out
Ctrl+L
Sleep 500ms
Type "kesha --format transcript tests/fixtures/benchmark-en/01-check-email.ogg"
Sleep 300ms
Enter
Sleep 5s

# 3. a Russian one as JSON, the shape an agent or a pipe consumes
Ctrl+L
Sleep 500ms
Type "kesha --json tests/fixtures/benchmark/03-ty-dobavil-sebe-v-pamyat.ogg"
Sleep 300ms
Enter
Sleep 6s

# 4. the other direction: text in, a wav out, on the default male voice
Ctrl+L
Sleep 500ms
Type `kesha say "Hi, I am Kesha. Nice to meet you." --out hello.wav`
Sleep 300ms
Enter
Sleep 4s

Sleep 800ms

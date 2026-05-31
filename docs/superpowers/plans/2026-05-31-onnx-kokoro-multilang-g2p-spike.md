# ONNX Kokoro Multilingual G2P — Spike Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide — with audio evidence — which G2P approach (A: static espeak-ng, B: CharsiuG2P+IPA-remap) gives correct es/fr/it/pt-br pronunciation through Kesha's existing ONNX Kokoro tokenizer + session, reaching Latin-5 parity with the CoreML path.

**Architecture:** A throwaway spike, not production code. Build a shared reference harness (upstream `kokoro-onnx` ground-truth audio + a fixed phonetic corpus + the audio-quality-check gate), then run Track A and Track B against it and fill a decision matrix. The winning approach gets its own implementation spec later. All work in the existing worktree `.worktrees/kokoro-mlang-g2p-spike/`; downloaded artifacts in `/tmp/kokoro-mlang-spike/`, deleted at the end.

**Tech Stack:** Rust (`ort`, `ndarray`, existing `rust/src/tts/{kokoro,tokenizer,g2p}.rs`), Python `kokoro-onnx` (disposable `/tmp` venv) for ground truth, `cargo nextest`, the `audio-quality-check` subagent.

**Spec:** `docs/superpowers/specs/2026-05-31-onnx-kokoro-multilang-g2p-spike-design.md`
**Tracking issue:** #212

---

## Pre-flight (already done / verify)

- [ ] **Step 1: Confirm the spike worktree is checked out and on its branch**

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike
git status -sb | head -1
```
Expected: `## spike/onnx-kokoro-multilang-g2p...origin/main`

- [ ] **Step 2: Confirm a Kokoro ONNX model is available locally (or install it)**

Run:
```bash
ls ~/.cache/kesha/models/kokoro-82m/model.onnx 2>/dev/null && echo FOUND || echo "run: kesha install --tts"
```
Expected: `FOUND`. If missing, run `kesha install --tts` before proceeding (the engine is never auto-downloaded).

- [ ] **Step 3: Create the scratch dir for downloaded artifacts**

Run:
```bash
mkdir -p /tmp/kokoro-mlang-spike/{refs,out-a,out-b}
echo ready
```
Expected: `ready`

---

## Phase 0 — Shared harness & reference corpus

> **Discovered at execution (2026-05-31):** the Kesha cache only holds English voice `.bin`s (`af_heart`, `am_michael`) — the ONNX path never downloads multilingual voices. Both the upstream reference (Task 0.2) and the Kesha-side render (Task 0.3) need the es/fr/it/pt voice embeddings, so Task 0.0 obtains them. The upstream `voices-v1.0.bin` is a combined `.npz`-style file keyed by voice name; Kesha's per-voice `.bin` is a flat little-endian f32 dump of the `[rows, 256]` style matrix.

### Task 0.0: Obtain multilingual voice embeddings (upstream pack → Kesha flat-f32)

**Files:**
- Create: `.worktrees/kokoro-mlang-g2p-spike/spike/extract_voices.py`

- [ ] **Step 1: Download the upstream kokoro-onnx voices pack into scratch**

Run:
```bash
/tmp/kokoro-mlang-spike/venv/bin/python3 -c "
from huggingface_hub import hf_hub_download
p = hf_hub_download('hexgrad/Kokoro-82M', 'voices/em_alex.pt')" 2>/dev/null || true
# Simpler/canonical: the combined voices-v1.0.bin shipped with kokoro-onnx releases.
curl -fsSL -o /tmp/kokoro-mlang-spike/voices-v1.0.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
ls -la /tmp/kokoro-mlang-spike/voices-v1.0.bin
```
Expected: a ~26 MB file. (If the URL has moved, find the current `voices-*.bin` asset on the kokoro-onnx releases page — record the resolved URL in the spec.)

- [ ] **Step 2: Write the extractor (upstream named arrays → Kesha flat-f32 `.bin`)**

```python
# spike/extract_voices.py — pull es/fr/it/pt voices into Kesha's flat-f32 layout.
import numpy as np, pathlib
SRC = "/tmp/kokoro-mlang-spike/voices-v1.0.bin"   # numpy .npz-style archive keyed by voice name
OUT = pathlib.Path("/tmp/kokoro-mlang-spike/voices"); OUT.mkdir(parents=True, exist_ok=True)
WANT = ["em_alex", "ff_siwis", "im_nicola", "pm_alex"]
data = np.load(SRC)                                # dict-like: name -> [rows, 1, 256] or [rows, 256]
for name in WANT:
    arr = np.asarray(data[name], dtype="<f4")
    arr = arr.reshape(arr.shape[0], -1)            # collapse to [rows, 256]
    assert arr.shape[1] == 256, f"{name}: expected 256 style dims, got {arr.shape}"
    (OUT / f"{name}.bin").write_bytes(arr.tobytes())
    print(f"{name}: {arr.shape} -> {OUT / (name + '.bin')}")
```

- [ ] **Step 3: Run the extractor (after Task 0.2 Step 1 creates the venv) and verify shapes**

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike
/tmp/kokoro-mlang-spike/venv/bin/pip install --quiet numpy
/tmp/kokoro-mlang-spike/venv/bin/python3 spike/extract_voices.py
ls /tmp/kokoro-mlang-spike/voices/*.bin | wc -l
```
Expected: `4`. Each `.bin` size = `rows * 256 * 4` bytes (rows ≈ 510). **Cross-check against a known-good Kesha voice:** `python3 -c "import os; print(os.path.getsize(os.path.expanduser('~/.cache/kesha/models/kokoro-82m/voices/am_michael.bin')))"` should equal the per-file size the extractor prints — if not, the reshape/layout is wrong and must be fixed before rendering.

- [ ] **Step 4: Commit the extractor**

```bash
git add spike/extract_voices.py
git commit -m "spike(tts): extract es/fr/it/pt voice embeddings into Kesha flat-f32"
```

> **Render tasks use these voices.** In Tasks 0.3 / A.2 / B.3, set `V=/tmp/kokoro-mlang-spike/voices` (NOT the Kesha cache, which lacks them).

### Task 0.1: Fixed phonetic corpus fixture

**Files:**
- Create: `.worktrees/kokoro-mlang-g2p-spike/spike/corpus.json` (spike-only, gitignored from production trees but committed on the spike branch for repeatability)

- [ ] **Step 1: Write the corpus fixture**

Phonetically dense per language + a shared row (digits / acronym / proper noun). Voices match the FluidAudio Latin set so A/B is apples-to-apples.

```json
{
  "es": {
    "voice": "em_alex",
    "sentences": [
      "El veloz murciélago hindú comía feliz cardillo y kiwi.",
      "La niña añadió jalapeños al guiso con cariño.",
      "Compré 27 libros y el código ISBN empezaba por X.",
      "El señor Núñez viajó de Cádiz a Zaragoza."
    ]
  },
  "fr": {
    "voice": "ff_siwis",
    "sentences": [
      "Portez ce vieux whisky au juge blond qui fume.",
      "Un bon vin blanc, un grand pont, enfin les enfants chantent.",
      "Il a payé 348 euros pour le billet TGV.",
      "Mademoiselle Béringer revient de Strasbourg."
    ]
  },
  "it": {
    "voice": "im_nicola",
    "sentences": [
      "Ma la volpe col suo balzo ha raggiunto il quieto Fido.",
      "Nonna Gioacchina cucina gnocchi e tagliatelle squisite.",
      "Ho speso 512 euro e la sigla era RAI.",
      "Il signor Castagnoli parte per Cagliari."
    ]
  },
  "pt": {
    "voice": "pm_alex",
    "sentences": [
      "Um pequeno jabuti xereta viu dez cegonhas felizes.",
      "A manhã de São João trouxe canções e corações cheios.",
      "Paguei 936 reais e a sigla era IBGE.",
      "O senhor Conceição viajou de Florianópolis a Belém."
    ]
  }
}
```

- [ ] **Step 2: Commit the corpus**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike
git add spike/corpus.json
git commit -m "spike(tts): fixed es/fr/it/pt phonetic corpus for G2P A/B"
```

### Task 0.2: Upstream ground-truth audio generator (disposable venv)

**Files:**
- Create: `.worktrees/kokoro-mlang-g2p-spike/spike/gen_reference.py`

- [ ] **Step 1: Stand up a throwaway venv (NEVER system-wide — CLAUDE.md rule)**

Run:
```bash
python3 -m venv /tmp/kokoro-mlang-spike/venv
/tmp/kokoro-mlang-spike/venv/bin/pip install --quiet "kokoro-onnx==0.4.9" soundfile
/tmp/kokoro-mlang-spike/venv/bin/python3 -c "import kokoro_onnx, soundfile; print('venv ok')"
```
Expected: `venv ok`. (Pin the version explicitly so the reference uses the same weights/voices Kesha ships — spec risk "Reference fidelity".)

- [ ] **Step 2: Write the reference generator**

```python
# spike/gen_reference.py — generate upstream ground-truth WAVs per (lang, sentence).
import json, sys, pathlib, soundfile as sf
from kokoro_onnx import Kokoro

CORPUS = json.loads(pathlib.Path("spike/corpus.json").read_text())
OUT = pathlib.Path("/tmp/kokoro-mlang-spike/refs")
# Use the SAME Kokoro weights Kesha ships; voices come from the upstream pack (Task 0.0).
MODEL = pathlib.Path.home() / ".cache/kesha/models/kokoro-82m/model.onnx"
VOICES = pathlib.Path("/tmp/kokoro-mlang-spike/voices-v1.0.bin")

kokoro = Kokoro(str(MODEL), str(VOICES))
LANG = {"es": "es", "fr": "fr-fr", "it": "it", "pt": "pt-br"}
for lang, spec in CORPUS.items():
    for i, text in enumerate(spec["sentences"]):
        samples, sr = kokoro.create(text, voice=spec["voice"], lang=LANG[lang])
        path = OUT / f"{lang}_{i}.wav"
        sf.write(path, samples, sr)
        print(f"wrote {path} ({len(samples)} samples @ {sr}Hz)")
```

- [ ] **Step 3: Generate the references and eyeball the count**

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike
/tmp/kokoro-mlang-spike/venv/bin/python3 spike/gen_reference.py
ls /tmp/kokoro-mlang-spike/refs/*.wav | wc -l
```
Expected: `16` (4 langs × 4 sentences). If `voices.bin` path differs, adjust to the actual upstream voice-pack layout and rerun.

- [ ] **Step 4: Gate the reference audio through audio-quality-check**

Dispatch the `audio-quality-check` agent on `/tmp/kokoro-mlang-spike/refs/`. Expected: no all-silence, sane length-vs-grapheme ratio, 24 kHz mono. This validates the ground truth itself before it's used as a yardstick.

- [ ] **Step 5: Commit the generator**

```bash
git add spike/gen_reference.py
git commit -m "spike(tts): upstream kokoro-onnx reference audio generator (disposable venv)"
```

### Task 0.3: Kesha-side render + compare harness

**Files:**
- Create: `.worktrees/kokoro-mlang-g2p-spike/rust/examples/spike_render.rs` (a Cargo example so it links the real `tts::tokenizer` + `tts::kokoro`)

- [ ] **Step 1: Write a Cargo example that renders IPA → WAV via the REAL Kesha session**

The example reads a `lang \t ipa` TSV on stdin and writes WAVs to an out dir, using the production tokenizer + Kokoro session so the only variable across tracks is the IPA source.

```rust
// rust/examples/spike_render.rs
// Usage: spike_render <model.onnx> <voice.bin> <out_dir> < ipa.tsv
// ipa.tsv lines: "<tag>\t<ipa string>"
use std::io::BufRead;
use std::path::Path;
use kesha_engine::tts::{kokoro::Kokoro, tokenizer::Tokenizer, voices};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (model, voice_bin, out_dir) = (&args[1], &args[2], &args[3]);
    let tok = Tokenizer::load()?;
    let mut k = Kokoro::load(Path::new(model))?;
    let voice = std::fs::read(voice_bin)?;
    let voice: Vec<f32> = voice
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let (tag, ipa) = line.split_once('\t').expect("tag\\tipa");
        let ids = Tokenizer::pad_to_context(tok.encode(ipa));
        let style = voices::select_style(&voice, ids.len());
        let audio = k.infer(&ids, style, 1.0)?;
        let path = format!("{out_dir}/{tag}.wav");
        write_wav_24k_mono(&path, &audio)?;
        println!("{tag}: {} samples", audio.len());
    }
    Ok(())
}

fn write_wav_24k_mono(path: &str, samples: &[f32]) -> anyhow::Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 24_000,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec)?;
    for s in samples {
        w.write_sample(*s)?;
    }
    w.finalize()?;
    Ok(())
}
```

> NOTE for the implementer: confirm `Tokenizer`, `Kokoro`, and `voices::select_style` are reachable from an example (they may need `pub`/`pub(crate)` widening, or move the example into a `#[cfg(test)]` integration binary). If widening visibility, keep it on the spike branch only — it is NOT part of the production change.

- [ ] **Step 2: Build the example to flush out visibility/API issues**

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike/rust
cargo build --example spike_render --features onnx 2>&1 | tail -20
```
Expected: compiles. If `kesha_engine::tts::...` paths are private, widen visibility (spike-only) until it builds, then rerun.

- [ ] **Step 3: Commit the harness**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike
git add rust/examples/spike_render.rs rust/src/tts/
git commit -m "spike(tts): IPA->WAV render harness via real Kesha tokenizer+session"
```

---

## Phase 1 — Track A: static espeak-ng

### Task A.1: Reproduce the dynamic-link wall, then find a static path

**Files:**
- Scratch only (no committed Rust dep changes until a path is proven)

- [ ] **Step 1: Re-confirm the #124 dynamic-only failure mode**

Run (scratch crate, NOT in the engine tree):
```bash
cargo new --bin /tmp/kokoro-mlang-spike/espeak-probe 2>/dev/null
cd /tmp/kokoro-mlang-spike/espeak-probe
cargo add espeakng-sys 2>&1 | tail -3
cargo build 2>&1 | tail -20
```
Expected: links dynamically against system `libespeak-ng` (or fails without it) — documents the baseline that #124 hit.

- [ ] **Step 2: Attempt a static build path (try each, record which works)**

Candidates, in order of least effort:
1. `espeakng-sys` with any `static`/`bundled` feature it exposes (`cargo add espeakng-sys --features ...`).
2. A pure-Rust port crate (e.g. `espeak-rs` / similar) if one produces espeak-ng IPA.
3. Vendor espeak-ng source + a `build.rs` `cc`/`cmake` static compile.

For whichever links, get IPA for one corpus sentence:
```bash
# pseudocode — exact API depends on the crate chosen; record the real call in the matrix
./target/debug/espeak-probe "Portez ce vieux whisky au juge blond." fr-fr
```
Expected: an IPA string. Record binary-size delta and which approach linked statically.

- [ ] **Step 3: Record feasibility per platform**

In the spec's decision matrix, fill Track A's "Static/link feasibility" and "Cross-platform viability" rows: proven on darwin-arm64 here; document the concrete path (or blocker) for ubuntu and windows. **No code commit** — this is a findings step.

### Task A.2: Track A end-to-end audio

- [ ] **Step 1: Emit `lang\tipa` TSV for the full corpus via the espeak path**

Run (script the chosen espeak binding over `spike/corpus.json`, lang codes es/fr-fr/it/pt-br):
```bash
# writes /tmp/kokoro-mlang-spike/ipa_a.tsv with lines "<lang>_<i>\t<ipa>"
/tmp/kokoro-mlang-spike/espeak-probe/run_corpus.sh > /tmp/kokoro-mlang-spike/ipa_a.tsv
wc -l /tmp/kokoro-mlang-spike/ipa_a.tsv
```
Expected: `16`.

- [ ] **Step 2: Render to WAV through the real Kesha session**

Per-voice `.bin` files live at `~/.cache/kesha/models/kokoro-82m/voices/<name>.bin` (layout confirmed by `rust/src/tts/voices.rs` tests). Render per language so each lang uses its corpus voice.

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike/rust
M=~/.cache/kesha/models/kokoro-82m/model.onnx
V=/tmp/kokoro-mlang-spike/voices   # extracted in Task 0.0 (cache lacks these)
declare -A VOICE=( [es]=em_alex [fr]=ff_siwis [it]=im_nicola [pt]=pm_alex )
for lang in es fr it pt; do
  grep "^${lang}_" /tmp/kokoro-mlang-spike/ipa_a.tsv \
    | cargo run --quiet --example spike_render --features onnx -- \
        "$M" "$V/${VOICE[$lang]}.bin" /tmp/kokoro-mlang-spike/out-a
done
ls /tmp/kokoro-mlang-spike/out-a/*.wav | wc -l
```
Expected: `16` WAVs.

- [ ] **Step 3: Deterministic gate**

Dispatch `audio-quality-check` on `/tmp/kokoro-mlang-spike/out-a/`. Expected: no all-silence, length-vs-grapheme ratios within band. Record pass/fail per file.

- [ ] **Step 4: A/B by ear vs refs**

Compare each `out-a/<lang>_<i>.wav` against `refs/<lang>_<i>.wav`. Record a per-language verdict (match / acceptable / wrong) in the matrix.

---

## Phase 2 — Track B: CharsiuG2P + IPA-remap

### Task B.1: Run CharsiuG2P over the corpus

**Files:**
- Create: `.worktrees/kokoro-mlang-g2p-spike/spike/charsiu_g2p.py` (scratch driver; CharsiuG2P inference is simplest from Python for the spike)

- [ ] **Step 1: Fetch the CharsiuG2P ByT5-tiny ONNX (the #123 model)**

Run:
```bash
/tmp/kokoro-mlang-spike/venv/bin/pip install --quiet huggingface_hub onnxruntime transformers
/tmp/kokoro-mlang-spike/venv/bin/python3 -c "
from huggingface_hub import snapshot_download
p = snapshot_download('charsiu/g2p_multilingual_byT5_tiny_16_layers_100', local_dir='/tmp/kokoro-mlang-spike/charsiu')
print(p)"
```
Expected: a local path with the model files. (Record exact repo id used — confirm it is the multilingual ByT5-tiny.)

- [ ] **Step 2: Emit `lang\tipa` TSV via CharsiuG2P**

Write `spike/charsiu_g2p.py` to phonemize each corpus sentence with the CharsiuG2P language tags for spa/fra/ita/por, writing `/tmp/kokoro-mlang-spike/ipa_b_raw.tsv` (lines `<lang>_<i>\t<ipa>`).

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike
/tmp/kokoro-mlang-spike/venv/bin/python3 spike/charsiu_g2p.py > /tmp/kokoro-mlang-spike/ipa_b_raw.tsv
wc -l /tmp/kokoro-mlang-spike/ipa_b_raw.tsv
```
Expected: `16`.

### Task B.2: Build and apply the IPA-remap layer (the #210 crux)

**Files:**
- Create: `.worktrees/kokoro-mlang-g2p-spike/spike/remap.py`

- [ ] **Step 1: Diff CharsiuG2P symbols against the Kokoro vocab**

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike
/tmp/kokoro-mlang-spike/venv/bin/python3 - <<'PY'
import json, pathlib, collections
vocab = set(json.loads(pathlib.Path("rust/fixtures/tts/kokoro_vocab.json").read_text()).keys())
seen = collections.Counter()
for line in pathlib.Path("/tmp/kokoro-mlang-spike/ipa_b_raw.tsv").read_text().splitlines():
    _, ipa = line.split("\t", 1)
    seen.update(ipa)
oov = {c: n for c, n in seen.items() if c not in vocab and not c.isspace()}
print("OOV symbols (CharsiuG2P -> Kokoro vocab):", oov)
PY
```
Expected: a list of symbols CharsiuG2P emits that Kokoro's vocab lacks — **this set is the fidelity gap #210 warned about.**

- [ ] **Step 2: Write `remap.py` mapping each OOV symbol to its nearest Kokoro-vocab phoneme**

Hand-author the mapping from the Step 1 output (e.g. length marks, tie bars, affricate spellings). Apply it to produce `/tmp/kokoro-mlang-spike/ipa_b.tsv`.

Run:
```bash
/tmp/kokoro-mlang-spike/venv/bin/python3 spike/remap.py /tmp/kokoro-mlang-spike/ipa_b_raw.tsv > /tmp/kokoro-mlang-spike/ipa_b.tsv
# verify zero residual OOV after remap
/tmp/kokoro-mlang-spike/venv/bin/python3 - <<'PY'
import json, pathlib
vocab=set(json.loads(pathlib.Path("rust/fixtures/tts/kokoro_vocab.json").read_text()).keys())
bad=[c for l in pathlib.Path("/tmp/kokoro-mlang-spike/ipa_b.tsv").read_text().splitlines() for c in l.split("\t",1)[1] if c not in vocab and not c.isspace()]
print("residual OOV:", set(bad))
PY
```
Expected: `residual OOV: set()`.

- [ ] **Step 3: Commit the scratch drivers**

```bash
git add spike/charsiu_g2p.py spike/remap.py
git commit -m "spike(tts): CharsiuG2P driver + IPA-remap to Kokoro vocab"
```

### Task B.3: Track B end-to-end audio

- [ ] **Step 1: Render Track B to WAV via the real Kesha session**

Run (same per-language render as Track A, into `out-b`):
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike/rust
M=~/.cache/kesha/models/kokoro-82m/model.onnx
V=/tmp/kokoro-mlang-spike/voices   # extracted in Task 0.0 (cache lacks these)
declare -A VOICE=( [es]=em_alex [fr]=ff_siwis [it]=im_nicola [pt]=pm_alex )
for lang in es fr it pt; do
  grep "^${lang}_" /tmp/kokoro-mlang-spike/ipa_b.tsv \
    | cargo run --quiet --example spike_render --features onnx -- \
        "$M" "$V/${VOICE[$lang]}.bin" /tmp/kokoro-mlang-spike/out-b
done
ls /tmp/kokoro-mlang-spike/out-b/*.wav | wc -l
```
Expected: `16`.

- [ ] **Step 2: Deterministic gate**

Dispatch `audio-quality-check` on `/tmp/kokoro-mlang-spike/out-b/`. Record pass/fail.

- [ ] **Step 3: A/B by ear vs refs**

Compare `out-b/<lang>_<i>.wav` against `refs/<lang>_<i>.wav` per language. Record verdicts.

---

## Phase 3 — Decision & handoff

### Task 3.1: Fill the decision matrix and recommend

**Files:**
- Modify: `docs/superpowers/specs/2026-05-31-onnx-kokoro-multilang-g2p-spike-design.md` (the matrix + a recommendation paragraph)

- [ ] **Step 1: Populate every matrix cell from the recorded evidence**

For A and B fill: phoneme match vs upstream, audio A/B by ear (per lang), audio-quality-check pass, static/link-or-model feasibility, cross-platform viability, integration cost.

- [ ] **Step 2: Apply the decision gate from the spec**

Write the recommendation: A if its static build is feasible (dev + credible ×3 path) and audio passes; else B if its remap audio passes; else escalate to C. State the loser's disqualifier explicitly.

- [ ] **Step 3: Commit the decision**

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike
git add docs/superpowers/specs/2026-05-31-onnx-kokoro-multilang-g2p-spike-design.md
git commit -m "spike(tts): record G2P decision matrix + recommendation (refs #212)"
```

### Task 3.2: Summarize on the issue and clean up

- [ ] **Step 1: Comment the finding on #212**

Run:
```bash
gh issue comment 212 -R drakulavich/kesha-voice-kit --body "Spike complete — see docs/superpowers/specs/2026-05-31-onnx-kokoro-multilang-g2p-spike-design.md. Decision: <A|B|C> because <one-liner>. Per-language A/B and audio-quality-check results in the matrix."
```
Expected: a comment URL.

- [ ] **Step 2: Delete scratch artifacts (CLAUDE.md spike-cleanup rule)**

Run:
```bash
rm -rf /tmp/kokoro-mlang-spike
echo "scratch removed"
```
Expected: `scratch removed`. (Committed `spike/` drivers + corpus stay on the branch for reproducibility; `/tmp` artifacts are disposable.)

- [ ] **Step 3: Open the PR for the spike branch (docs + findings only)**

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/kokoro-mlang-g2p-spike
git push -u origin spike/onnx-kokoro-multilang-g2p
gh pr create --base main --head spike/onnx-kokoro-multilang-g2p \
  --title "spike(tts): ONNX Kokoro multilingual G2P — design, harness, decision (refs #212)" \
  --body "Decision-gated spike for es/fr/it/pt parity on the ONNX path. Contains the spike spec, reference harness, and the filled decision matrix. No production wiring — the winning approach gets its own implementation spec. Refs #212."
```
Expected: a PR URL. Then wait for CI + Greptile per the repo's review-gate rule.

---

## Follow-up (out of scope for this plan)

Once the decision lands, run a **fresh brainstorm → spec → plan** cycle for the chosen approach's production implementation: wiring G2P into `rust/src/tts/g2p.rs`, extending `voices.rs` Latin-5 routing, install-plan/model pins (if B), the build-engine feature matrix, and CI audio regression. That implementation is intentionally NOT part of this spike.

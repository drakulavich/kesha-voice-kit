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

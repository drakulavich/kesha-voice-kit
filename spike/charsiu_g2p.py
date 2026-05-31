#!/usr/bin/env python3
"""
spike/charsiu_g2p.py — B.1: CharsiuG2P multilingual phonemization for the spike corpus.

Model: charsiu/g2p_multilingual_byT5_tiny_16_layers_100 (MIT license)
Runs via transformers (PyTorch); no ONNX export needed for the spike.
Output: /tmp/kokoro-mlang-spike/ipa_b_raw.tsv  (lines: "<lang>_<i>\t<ipa>")

Language tags used (from CharsiuG2P's language code spreadsheet):
  es -> <spa>       (Castilian Spanish)
  fr -> <fra>       (French)
  it -> <ita>       (Italian)
  pt -> <por-bz>    (Brazilian Portuguese — matches corpus sentences)
"""

import json
import pathlib
import re
import sys
import warnings

warnings.filterwarnings("ignore")

from transformers import T5ForConditionalGeneration, AutoTokenizer

# Paths
CORPUS_PATH = pathlib.Path("spike/corpus.json")
MODEL_DIR = "/tmp/kokoro-mlang-spike/charsiu"
OUT_PATH = pathlib.Path("/tmp/kokoro-mlang-spike/ipa_b_raw.tsv")

# CharsiuG2P language tags for each corpus language
LANG_TAG = {
    "es": "spa",
    "fr": "fra",
    "it": "ita",
    "pt": "por-bz",
}

# Batch size for model inference
BATCH_SIZE = 32


def tokenize_sentence(text: str) -> list[str]:
    """Split sentence into words, stripping punctuation attached to words.
    Returns list of (word, has_trailing_space) but we just need words for G2P.
    Punctuation characters are kept as separate tokens for IPA joining.
    """
    # Split on whitespace, then strip leading/trailing punctuation per token
    # but keep the stripped punctuation for reassembly
    tokens = []
    for raw in text.split():
        # Strip leading/trailing punctuation
        stripped = raw.strip(".,!?;:\"'()[]{}—…")
        if stripped:
            tokens.append(stripped)
    return tokens


def phonemize_sentence(words: list[str], lang_tag: str, model, tokenizer) -> str:
    """Phonemize a list of words with CharsiuG2P, return space-joined IPA."""
    if not words:
        return ""

    # Format: "<lang_tag>: word"
    tagged = [f"<{lang_tag}>: {w}" for w in words]

    # Batch tokenize
    inputs = tokenizer(
        tagged,
        padding=True,
        add_special_tokens=False,
        return_tensors="pt",
    )
    preds = model.generate(**inputs, num_beams=1, max_length=50)
    phones = tokenizer.batch_decode(preds.tolist(), skip_special_tokens=True)

    return " ".join(phones)


def main():
    corpus = json.loads(CORPUS_PATH.read_text())

    print("Loading CharsiuG2P model...", file=sys.stderr)
    model = T5ForConditionalGeneration.from_pretrained(MODEL_DIR)
    tokenizer = AutoTokenizer.from_pretrained("google/byt5-small")
    model.eval()
    print("Model loaded.", file=sys.stderr)

    lines = []
    for lang, spec in corpus.items():
        tag = LANG_TAG[lang]
        for i, sentence in enumerate(spec["sentences"]):
            words = tokenize_sentence(sentence)
            ipa = phonemize_sentence(words, tag, model, tokenizer)
            key = f"{lang}_{i}"
            lines.append(f"{key}\t{ipa}")
            print(f"  {key}: {ipa}", file=sys.stderr)

    OUT_PATH.write_text("\n".join(lines) + "\n")
    print(f"\nWrote {len(lines)} lines to {OUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()

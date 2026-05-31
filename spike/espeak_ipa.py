#!/usr/bin/env python3
"""
spike/espeak_ipa.py — generate IPA for all corpus sentences via espeak-ng CLI.
Writes /tmp/kokoro-mlang-spike/ipa_a.tsv with lines "<lang>_<i>\t<ipa>".
Also reports IPA char survival rate vs kokoro_vocab.json.
"""
import json
import pathlib
import re
import subprocess
import collections

CORPUS = json.loads(pathlib.Path("spike/corpus.json").read_text())
VOCAB = set(
    json.loads(
        pathlib.Path("rust/fixtures/tts/kokoro_vocab.json").read_text()
    ).keys()
)
OUT = pathlib.Path("/tmp/kokoro-mlang-spike/ipa_a.tsv")

# espeak-ng voice codes per lang
VOICE = {"es": "es", "fr": "fr-fr", "it": "it", "pt": "pt-br"}

# Strip espeak language-switch markers like (en), (fr), (pt), etc.
_LANG_SWITCH = re.compile(r"\([a-z]{2,3}\)")
# Strip stress markers and length mark from IPA — these are retained in Kokoro vocab
# so we keep ˈ ˌ ː. Strip only chars that are clearly non-IPA artifacts:
# · (syllable dot, not in Kokoro vocab), - (syllable boundary marker espeak emits as "s-")
_ARTEFACTS = re.compile(r"[·\-\n]")


def clean_ipa(raw: str) -> str:
    """Remove espeak-ng artefacts from IPA string."""
    s = _LANG_SWITCH.sub("", raw)
    s = _ARTEFACTS.sub("", s)
    # Collapse multiple spaces
    s = re.sub(r"  +", " ", s).strip()
    return s


lines = []
total_chars = 0
dropped_chars = 0
oov_counter = collections.Counter()

for lang, spec in CORPUS.items():
    voice = VOICE[lang]
    for i, sentence in enumerate(spec["sentences"]):
        result = subprocess.run(
            ["espeak-ng", "-q", "--ipa", "-v", voice, sentence],
            capture_output=True,
            text=True,
        )
        # Fail loud — a non-zero exit (missing voice, bad install) would
        # otherwise yield an empty IPA line and silently skew the survival stat.
        if result.returncode != 0:
            raise SystemExit(
                f"espeak-ng failed ({result.returncode}) for {lang}_{i} "
                f"voice={voice}: {result.stderr.strip()}"
            )
        raw_ipa = result.stdout.strip()
        if not raw_ipa:
            raise SystemExit(f"espeak-ng produced empty IPA for {lang}_{i}: {sentence!r}")
        ipa = clean_ipa(raw_ipa)
        tag = f"{lang}_{i}"
        lines.append(f"{tag}\t{ipa}")

        # Count survival vs vocab
        for ch in ipa:
            if ch == " ":
                continue
            total_chars += 1
            if ch not in VOCAB:
                dropped_chars += 1
                oov_counter[ch] += 1

        print(f"{tag}: {repr(raw_ipa)}")
        print(f"  -> clean: {repr(ipa)}")

OUT.write_text("\n".join(lines) + "\n")
print(f"\nWrote {len(lines)} lines to {OUT}")

survival = 100.0 * (total_chars - dropped_chars) / total_chars if total_chars else 0
drop_rate = 100.0 - survival
print(f"\nIPA char stats (excluding spaces):")
print(f"  Total chars: {total_chars}")
print(f"  Survived (in vocab): {total_chars - dropped_chars} ({survival:.1f}%)")
print(f"  Dropped (OOV): {dropped_chars} ({drop_rate:.1f}%)")
if oov_counter:
    print(f"  OOV chars: {dict(oov_counter.most_common(30))}")
else:
    print("  OOV chars: none")

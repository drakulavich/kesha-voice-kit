#!/usr/bin/env python3
"""
spike/remap.py -- B.2: Map CharsiuG2P IPA symbols to Kokoro vocab.

Usage: python3 spike/remap.py <ipa_b_raw.tsv>  > /tmp/kokoro-mlang-spike/ipa_b.tsv

OOV symbols found in CharsiuG2P output (vs kokoro_vocab.json):
  U+0361  (tie bar)         -- 5 occurrences, in t+tie+s, d+tie+dz, t+tie+sh sequences
  U+0067  'g' Latin small g -- 3 occurrences (Kokoro uses U+0261 script g)
  U+00F5  o-tilde           -- 3 occurrences (Portuguese nasal o, pre-composed)
  U+0169  u-tilde           -- 1 occurrence  (Portuguese nasal u, pre-composed)
  U+1EBD  e-tilde           -- 1 occurrence  (Portuguese nasal e, pre-composed)

Remap decisions:
  t+tie+s  -> U+02A6 (Kokoro affricate token)
  d+tie+dz -> U+02A4 (Kokoro affricate token)
  t+tie+sh -> U+02A7 (Kokoro affricate token)
  U+0067 g -> U+0261 (identical phoneme, glyph difference only)
  U+00F5   -> o + U+0303 combining tilde (NFD decomposition; both tokens in Kokoro vocab)
  U+0169   -> u + U+0303 combining tilde
  U+1EBD   -> e + U+0303 combining tilde

The combining tilde U+0303 is in the Kokoro vocab as a standalone token.
After decomposition base vowel (o/u/e) is also in vocab -> zero residual OOV.

Fidelity notes:
  - Affricate substitution is exact: Kokoro-native single tokens.
  - g->script-g is phonetically identical; purely a codepoint normalisation.
  - Nasal vowel decomposition is what Kokoro itself uses (Track A espeak also
    emits decomposed form), so fidelity is preserved.
"""

import sys
import pathlib

# Tie bar U+0361
_TIE = "͡"

# Affricate base characters
_t = "t"
_d = "d"
_s = "s"
_ZH = "ʒ"   # ezh (dz component)
_SH = "ʃ"   # esh (sh component)

# Kokoro affricate tokens
_TS  = "ʦ"  # ts ligature
_DZH = "ʤ"  # dz ligature
_TSH = "ʧ"  # tsh ligature

# Ordered substitutions: longest sequences first so the tie-bar sequences
# are consumed before the standalone tie-bar fallback.
SUBSTITUTIONS: list[tuple[str, str]] = [
    # Tie-bar affricate triples -> Kokoro single affricate tokens
    (_t + _TIE + _s,   _TS),   # t+tie+s  -> U+02A6
    (_t + _TIE + _SH,  _TSH),  # t+tie+sh -> U+02A7
    (_d + _TIE + _ZH,  _DZH),  # d+tie+zh -> U+02A4
    # Fallback: bare tie bar that survived the above (safety net)
    (_TIE, ""),
    # Latin small g (U+0067) -> script g (U+0261) used by Kokoro
    ("g", "ɡ"),
    # Pre-composed nasal vowels -> NFD: base vowel + combining tilde U+0303
    ("õ", "õ"),   # o-tilde -> o + combining tilde
    ("ũ", "ũ"),   # u-tilde -> u + combining tilde
    ("ẽ", "ẽ"),   # e-tilde -> e + combining tilde
]


def remap(ipa: str) -> str:
    for src, dst in SUBSTITUTIONS:
        ipa = ipa.replace(src, dst)
    return ipa


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: remap.py <ipa_b_raw.tsv>", file=sys.stderr)
        sys.exit(1)

    src_path = pathlib.Path(sys.argv[1])
    lines = src_path.read_text(encoding="utf-8").splitlines()

    out_lines = []
    for line in lines:
        if not line.strip():
            continue
        tag, ipa = line.split("\t", 1)
        out_lines.append(f"{tag}\t{remap(ipa)}")

    print("\n".join(out_lines))


if __name__ == "__main__":
    main()

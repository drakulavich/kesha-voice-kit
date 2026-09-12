---
paths:
  - "**/*.py"
---

# Python runs in a venv

Python here is spike tooling and three committed helpers, never a runtime surface. Create a venv under `/tmp/` and delete it after; never `pip install --break-system-packages`, never `pip3 install` against the system interpreter, never `pipx` for libraries. If a spike becomes project work, ask which env tool the user wants rather than installing system-wide. `.github/scripts/generate-mini-models.py` and `scripts/convert-lang-id-model.py` carry the recipe in their headers; `rust/tests/fixtures/regen-tone-no-eos.py` needs only the standard library and `ffmpeg`.

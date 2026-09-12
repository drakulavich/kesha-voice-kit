---
paths:
  - "**/*.py"
---

# Python is spike-only, and lives in a venv

When spiking against an upstream Python reference, create a venv under `/tmp/` and delete it after. Never `pip install --break-system-packages`, never `pip3 install` against the system interpreter, never `pipx` for libraries. If a spike becomes project work, ask which env tool the user wants rather than installing system-wide. The three committed `.py` helpers run the same way.

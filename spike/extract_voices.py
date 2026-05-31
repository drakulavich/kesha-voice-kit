# spike/extract_voices.py — pull es/fr/it/pt voices into Kesha's flat-f32 layout.
import numpy as np, pathlib, os

SRC = "/tmp/kokoro-mlang-spike/voices-v1.0.bin"   # numpy .npz-style archive keyed by voice name
OUT = pathlib.Path("/tmp/kokoro-mlang-spike/voices"); OUT.mkdir(parents=True, exist_ok=True)
WANT = ["em_alex", "ff_siwis", "im_nicola", "pm_alex"]
KESHA_VOICE = os.path.expanduser("~/.cache/kesha/models/kokoro-82m/voices/am_michael.bin")

data = np.load(SRC)                                # dict-like: name -> [rows, 1, 256] or [rows, 256]
ref_size = os.path.getsize(KESHA_VOICE)
print(f"Reference am_michael.bin size: {ref_size} bytes")

for name in WANT:
    arr = np.asarray(data[name], dtype="<f4")
    arr = arr.reshape(arr.shape[0], -1)            # collapse to [rows, 256]
    assert arr.shape[1] == 256, f"{name}: expected 256 style dims, got {arr.shape}"
    out_path = OUT / f"{name}.bin"
    out_path.write_bytes(arr.tobytes())
    size = out_path.stat().st_size
    match = "OK" if size == ref_size else f"MISMATCH (expected {ref_size})"
    print(f"{name}: {arr.shape} -> {out_path} ({size} bytes) [{match}]")

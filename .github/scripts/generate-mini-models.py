"""Generate the Kokoro mini stand-in committed under tests/fixtures/mini-models/.

The mini carries Kokoro-82M's exact I/O signature — `tokens` int64 [1,N], `style`
f32 [1,256], `speed` f32 [1] -> `audio` f32 [T] at 24 kHz — and none of its
weights. It exists so the lanes that only assert audio *structure* stop paying
326 MB of cache for it (#741); `rust/tests/mini_model_pact.rs` is what keeps the
signature honest against the real model.

Deliberately not a learned model: it emits a fixed 220 Hz tone whose length is
`tokens x SAMPLES_PER_TOKEN / speed`, which is the only behaviour the structural
assertions read (non-silent, unclipped, 24 kHz mono, duration tracking text
length and `--rate`). It reads `style` so a wrong-shaped voice pack still fails.

Run inside a throwaway venv, per CLAUDE.md's no-system-python rule:

    python3 -m venv /tmp/mini-venv && /tmp/mini-venv/bin/pip install 'onnx==1.22.0' numpy
    /tmp/mini-venv/bin/python .github/scripts/generate-mini-models.py \
        tests/fixtures/mini-models/kokoro
    rm -rf /tmp/mini-venv

Output is byte-reproducible at a fixed onnx version, which mini-model-pact.yml
re-checks weekly — hence the pin above. Bumping it re-writes the artifacts.
"""

import hashlib
import json
import math
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

SAMPLE_RATE = 24_000
SAMPLES_PER_TOKEN = 1200.0
TONE_HZ = 220.0
AMPLITUDE = 0.2
VOICE_ROWS, VOICE_COLS = 510, 256
VOICE_SEED = 741
OPSET = 17
IR_VERSION = 9


def _const(name, value, dtype=TensorProto.FLOAT):
    arr = np.array(value, dtype=np.float32 if dtype == TensorProto.FLOAT else np.int64)
    return helper.make_node("Constant", [], [name], value=numpy_helper.from_array(arr, name))


def build_graph():
    nodes = [
        _const("idx0", 0, TensorProto.INT64),
        _const("idx1", 1, TensorProto.INT64),
        _const("samples_per_token", SAMPLES_PER_TOKEN),
        _const("omega", 2.0 * math.pi * TONE_HZ / SAMPLE_RATE),
        _const("amplitude", AMPLITUDE),
        _const("zero", 0.0),
        _const("range_start", 0.0),
        _const("range_delta", 1.0),
        helper.make_node("Shape", ["tokens"], ["tok_shape"]),
        helper.make_node("Gather", ["tok_shape", "idx1"], ["n"], axis=0),
        helper.make_node("Cast", ["n"], ["n_f"], to=TensorProto.FLOAT),
        helper.make_node("Mul", ["n_f", "samples_per_token"], ["raw_len"]),
        # `speed` arrives as [1]; a scalar Gather index drops the rank Range needs.
        helper.make_node("Gather", ["speed", "idx0"], ["speed_scalar"], axis=0),
        helper.make_node("Div", ["raw_len", "speed_scalar"], ["audio_len"]),
        helper.make_node("Range", ["range_start", "audio_len", "range_delta"], ["t"]),
        helper.make_node("Mul", ["t", "omega"], ["phase"]),
        helper.make_node("Sin", ["phase"], ["wave"]),
        # Consume `style` so a mis-shaped voice pack cannot slip through unread.
        helper.make_node("Gather", ["style", "idx0"], ["style_row"], axis=0),
        helper.make_node("Gather", ["style_row", "idx0"], ["style_scalar"], axis=0),
        helper.make_node("Mul", ["style_scalar", "zero"], ["style_bias"]),
        helper.make_node("Add", ["amplitude", "style_bias"], ["gain"]),
        helper.make_node("Mul", ["wave", "gain"], ["audio"]),
    ]
    graph = helper.make_graph(
        nodes,
        "kokoro-mini",
        [
            helper.make_tensor_value_info("tokens", TensorProto.INT64, [1, "N"]),
            helper.make_tensor_value_info("style", TensorProto.FLOAT, [1, VOICE_COLS]),
            helper.make_tensor_value_info("speed", TensorProto.FLOAT, [1]),
        ],
        [helper.make_tensor_value_info("audio", TensorProto.FLOAT, ["T"])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", OPSET)])
    model.ir_version = IR_VERSION
    onnx.checker.check_model(model)
    return model


def build_voice_pack():
    """`load_voice` rejects anything but exactly VOICE_ROWS x VOICE_COLS x 4 bytes."""
    rng = np.random.default_rng(VOICE_SEED)
    return (rng.standard_normal((VOICE_ROWS, VOICE_COLS), dtype=np.float32) * 0.1).tobytes()


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    onnx.save(build_graph(), os.path.join(out_dir, "model.onnx"))
    with open(os.path.join(out_dir, "am_michael.bin"), "wb") as fh:
        fh.write(build_voice_pack())

    digests = {}
    for name in ("model.onnx", "am_michael.bin"):
        path = os.path.join(out_dir, name)
        digests[name] = {
            "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
            "bytes": os.path.getsize(path),
        }

    marker = {
        "kind": "mini-model",
        "warning": "Synthetic stand-in. Carries Kokoro's I/O signature, none of its weights. "
        "A lane staged with this must never claim real-model coverage.",
        "model": "kokoro-82m",
        "generator": ".github/scripts/generate-mini-models.py",
        "onnx_version": onnx.__version__,
        "opset": OPSET,
        "ir_version": IR_VERSION,
        "params": {
            "sample_rate": SAMPLE_RATE,
            "samples_per_token": SAMPLES_PER_TOKEN,
            "tone_hz": TONE_HZ,
            "amplitude": AMPLITUDE,
            "voice_rows": VOICE_ROWS,
            "voice_cols": VOICE_COLS,
            "voice_seed": VOICE_SEED,
        },
        "files": digests,
    }
    with open(os.path.join(out_dir, "MINI-MODEL.json"), "w") as fh:
        json.dump(marker, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(json.dumps(digests, indent=2, sort_keys=True))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/mini-models/kokoro")

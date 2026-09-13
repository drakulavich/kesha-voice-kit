#!/usr/bin/env python3
"""
Convert speechbrain/lang-id-voxlingua107-ecapa to ONNX and CoreML.

Usage (inside a throwaway venv, per .claude/rules/python.md):
    python3 -m venv /tmp/lang-id-venv
    /tmp/lang-id-venv/bin/pip install torch speechbrain coremltools onnx onnxruntime onnxscript
    /tmp/lang-id-venv/bin/python scripts/convert-lang-id-model.py [--output-dir DIR]
    rm -rf /tmp/lang-id-venv

Produces:
    - lang-id-ecapa.onnx + .onnx.data  (ONNX, ~86MB total)
    - lang-id-ecapa.mlpackage           (CoreML, ~40MB)
    - lang-id-ecapa.mlpackage.tar.gz    (CoreML archive for distribution)
    - labels.json                        (107 ISO 639-1 codes)

Notes:
    - ONNX model takes raw waveform [1, samples] at 16kHz, outputs language_probs [1, 107]
    - CoreML model takes precomputed mel features [1, T, 60], outputs language_logits [1, 107]
      (softmax must be applied by the consumer — coremltools can't convert the traced softmax op)
    - The CoreML export uses torch.export + run_decompositions to avoid coremltools bugs
      with jit.trace (the 'int' op conversion error in softmax)
"""

import argparse
import json
import os
import sys
import tarfile

import numpy as np
import torch
import torch.nn as nn


def main():
    parser = argparse.ArgumentParser(description="Convert ECAPA-TDNN lang-id model")
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Directory to write converted models (default: current dir)",
    )
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    print("Loading SpeechBrain lang-id model...")
    from speechbrain.inference.classifiers import EncoderClassifier

    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/lang-id-voxlingua107-ecapa",
        savedir=os.path.join(args.output_dir, "tmp-speechbrain-cache"),
    )

    # Extract labels as ISO 639-1 codes
    print("Extracting language labels...")
    raw_labels = list(classifier.hparams.label_encoder.ind2lab.values())
    labels = [l.split(":")[0] for l in raw_labels]  # "en: English" -> "en"
    labels_path = os.path.join(args.output_dir, "labels.json")
    with open(labels_path, "w") as f:
        json.dump(labels, f)
    print(f"  Saved {len(labels)} labels to {labels_path}")

    # --- ONNX Export ---
    # Full pipeline: waveform -> mel -> embedding -> classifier -> softmax -> probs
    class LangIdFullWrapper(nn.Module):
        def __init__(self, classifier):
            super().__init__()
            self.compute_features = classifier.mods.compute_features
            self.mean_var_norm = classifier.mods.mean_var_norm
            self.embedding_model = classifier.mods.embedding_model
            self.classifier_mod = classifier.mods.classifier

        def forward(self, wavs):
            feats = self.compute_features(wavs)
            feats = self.mean_var_norm(feats, torch.ones(feats.shape[0], device=feats.device))
            embeddings = self.embedding_model(feats)
            outputs = self.classifier_mod(embeddings)
            probs = torch.softmax(outputs.squeeze(1), dim=-1)
            return probs

    full_wrapper = LangIdFullWrapper(classifier)
    full_wrapper.eval()

    dummy_wav = torch.randn(1, 160000)  # 10s at 16kHz

    print("Verifying forward pass...")
    with torch.no_grad():
        test_output = full_wrapper(dummy_wav)
    print(f"  Output shape: {test_output.shape}")
    print(f"  Sum of probs: {test_output.sum().item():.4f} (should be ~1.0)")
    top_idx = test_output.argmax(dim=-1).item()
    print(f"  Top prediction: {labels[top_idx]} ({test_output[0, top_idx].item():.4f})")

    onnx_path = os.path.join(args.output_dir, "lang-id-ecapa.onnx")
    print(f"\nExporting to ONNX: {onnx_path}")
    torch.onnx.export(
        full_wrapper,
        dummy_wav,
        onnx_path,
        input_names=["waveform"],
        output_names=["language_probs"],
        dynamic_axes={
            "waveform": {0: "batch", 1: "time"},
            "language_probs": {0: "batch"},
        },
        opset_version=17,
    )

    # Check total ONNX size (may have external data file)
    onnx_total = 0
    for f in os.listdir(args.output_dir):
        if f.startswith("lang-id-ecapa.onnx"):
            onnx_total += os.path.getsize(os.path.join(args.output_dir, f))
    print(f"  ONNX export complete: {onnx_total / (1024 * 1024):.1f} MB total")

    # Verify ONNX model
    print("  Verifying ONNX model...")
    import onnxruntime as ort

    session = ort.InferenceSession(onnx_path)
    onnx_result = session.run(None, {"waveform": dummy_wav.numpy()})
    onnx_probs = onnx_result[0]
    print(f"  ONNX output shape: {onnx_probs.shape}")
    print(f"  ONNX sum: {onnx_probs.sum():.4f}")
    onnx_top = np.argmax(onnx_probs, axis=-1)[0]
    print(f"  ONNX top: {labels[onnx_top]} ({onnx_probs[0, onnx_top]:.4f})")

    max_diff = np.abs(test_output.detach().numpy() - onnx_probs).max()
    print(f"  Max diff PyTorch vs ONNX: {max_diff:.6f}")

    # --- CoreML Export ---
    # Embedding-only: mel features -> embedding -> classifier -> logits (no softmax)
    # coremltools has a bug with traced softmax's 'int' op, and can't handle STFT.
    # So CoreML takes precomputed mel features and outputs raw logits.
    # The Swift consumer applies softmax.
    class LangIdEmbeddingWrapper(nn.Module):
        def __init__(self, classifier):
            super().__init__()
            self.embedding_model = classifier.mods.embedding_model
            self.classifier_mod = classifier.mods.classifier

        def forward(self, feats):
            embeddings = self.embedding_model(feats)
            outputs = self.classifier_mod(embeddings)
            return outputs.squeeze(1)  # raw logits [batch, num_langs]

    embedding_wrapper = LangIdEmbeddingWrapper(classifier)
    embedding_wrapper.eval()

    # Compute mel features to get the input shape
    with torch.no_grad():
        feats = classifier.mods.compute_features(dummy_wav)
        feats = classifier.mods.mean_var_norm(feats, torch.ones(1))
    print(f"\nMel features shape for CoreML: {feats.shape}")

    coreml_path = os.path.join(args.output_dir, "lang-id-ecapa.mlpackage")
    print(f"Exporting to CoreML: {coreml_path}")
    try:
        import coremltools as ct

        # Use torch.export + decompositions (avoids jit.trace bugs in coremltools)
        exported = torch.export.export(embedding_wrapper, (feats,), strict=False)
        exported = exported.run_decompositions({})

        mlmodel = ct.convert(
            exported,
            inputs=[ct.TensorType(name="features", shape=feats.shape, dtype=float)],
            outputs=[ct.TensorType(name="language_logits")],
            compute_units=ct.ComputeUnit.ALL,
            minimum_deployment_target=ct.target.macOS14,
        )
        mlmodel.save(coreml_path)
        print("  CoreML export complete")

        # Verify on macOS
        if sys.platform == "darwin":
            print("  Verifying CoreML model...")
            prediction = mlmodel.predict({"features": feats.numpy()})
            logits = prediction["language_logits"]
            from scipy.special import softmax
            probs = softmax(logits, axis=-1)
            coreml_top = np.argmax(probs)
            print(f"  CoreML top: {labels[coreml_top]} ({probs.flat[coreml_top]:.4f})")
    except Exception as e:
        print(f"  CoreML export failed: {e}")
        print("  You can still use the ONNX model.")

    # Create tar.gz archive for distribution
    if os.path.isdir(coreml_path):
        tar_path = os.path.join(args.output_dir, "lang-id-ecapa.mlpackage.tar.gz")
        print(f"\nCreating archive: {tar_path}")
        with tarfile.open(tar_path, "w:gz") as tar:
            tar.add(coreml_path, arcname="lang-id-ecapa.mlpackage")
        tar_size = os.path.getsize(tar_path) / (1024 * 1024)
        print(f"  Archive: {tar_size:.1f} MB")

    print("\nDone! Files produced:")
    for f in sorted(os.listdir(args.output_dir)):
        if f.startswith("tmp-"):
            continue
        path = os.path.join(args.output_dir, f)
        if os.path.isdir(path):
            print(f"  {f}/ (directory)")
        else:
            size = os.path.getsize(path) / (1024 * 1024)
            print(f"  {f} ({size:.1f} MB)")


if __name__ == "__main__":
    main()

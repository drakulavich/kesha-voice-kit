import { isCoreMLInstalled } from "./coreml";
import { isModelCached } from "./onnx-install";

export * from "./onnx-install";
export * from "./coreml-install";

export function isModelInstalled(modelDir?: string): boolean {
  return isCoreMLInstalled() || isModelCached(modelDir);
}

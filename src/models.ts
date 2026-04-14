import { isEngineInstalled } from "./engine";
export { downloadEngine } from "./engine-install";

export function isModelInstalled(): boolean {
  return isEngineInstalled();
}

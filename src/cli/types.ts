/**
 * Fields shared between the `install` and `init` command args. Both commands
 * accept the same backend/cache/model flags; defining the shape here (rather
 * than in either command module) keeps `init` from importing a type out of its
 * sibling `install` command just to extend it.
 */
export interface SharedInstallArgs {
  coreml: boolean;
  onnx: boolean;
  "no-cache": boolean;
  noCache?: boolean;
  no_cache?: boolean;
  tts: boolean;
  vad: boolean;
  diarize: boolean;
  plan: boolean;
}

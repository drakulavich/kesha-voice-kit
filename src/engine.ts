import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

export interface LangDetectResult {
  code: string;
  confidence: number;
}

const ENGINE_BIN_PATH = join(homedir(), ".cache", "kesha", "engine", "bin", "kesha-engine");

export function getEngineBinPath(): string {
  return ENGINE_BIN_PATH;
}

export function isEngineInstalled(): boolean {
  return existsSync(getEngineBinPath());
}

async function runEngine(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binPath = getEngineBinPath();
  const proc = Bun.spawn([binPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export async function transcribeEngine(audioPath: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runEngine(["transcribe", audioPath]);
  if (exitCode !== 0) {
    throw new Error(stderr || `kesha-engine exited with code ${exitCode}`);
  }
  return stdout;
}

export function parseLangResult(stdout: string): LangDetectResult | null {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.code !== "string" || typeof parsed.confidence !== "number") {
      return null;
    }
    return { code: parsed.code, confidence: parsed.confidence };
  } catch {
    return null;
  }
}

export async function detectAudioLanguageEngine(audioPath: string): Promise<LangDetectResult | null> {
  if (!isEngineInstalled()) return null;
  const { stdout, exitCode } = await runEngine(["detect-lang", audioPath]);
  if (exitCode !== 0) return null;
  return parseLangResult(stdout);
}

export async function detectTextLanguageEngine(text: string): Promise<LangDetectResult | null> {
  if (!isEngineInstalled()) return null;
  const { stdout, exitCode } = await runEngine(["detect-text-lang", text]);
  if (exitCode !== 0) return null;
  return parseLangResult(stdout);
}

export interface EngineCapabilities {
  protocolVersion: number;
  backend: string;
  features: string[];
}

export async function getEngineCapabilities(): Promise<EngineCapabilities | null> {
  if (!isEngineInstalled()) return null;
  const { stdout, exitCode } = await runEngine(["--capabilities-json"]);
  if (exitCode !== 0) return null;
  try {
    return JSON.parse(stdout) as EngineCapabilities;
  } catch {
    return null;
  }
}

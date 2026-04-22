import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  getPreferenceValues,
  getSelectedFinderItems,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface Prefs {
  keshaBinPath?: string;
}

// Matches TranscribeResult from @drakulavich/kesha-voice-kit/core (src/types.ts).
interface TranscribeResult {
  file: string;
  text: string;
  lang: string;
  audioLanguage?: { code: string; confidence: number };
  textLanguage?: { code: string; confidence: number };
  sttTimeMs?: number;
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string; hint?: string }
  | { status: "ok"; result: TranscribeResult; rawJson: string };

export default function Command() {
  const prefs = getPreferenceValues<Prefs>();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    // Guard against setState after unmount + strict-mode double-mount
    // resurrecting a stale transcription. The subprocess itself is
    // idempotent (same file → same transcript), so the worst a stray
    // second run does is a duplicate `kesha --json` call — the setState
    // gate stops the stale result from clobbering the real one.
    let mounted = true;
    void transcribe(prefs.keshaBinPath?.trim() || "kesha")
      .then((next) => {
        if (mounted) setState(next);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "error", message });
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (state.status === "loading") {
    return <Detail isLoading markdown="Transcribing…" />;
  }

  if (state.status === "error") {
    const body = state.hint
      ? `${state.message}\n\n${state.hint}`
      : state.message;
    return <Detail markdown={`# Error\n\n${body}`} />;
  }

  const { result, rawJson } = state;
  const markdown = buildMarkdown(result);

  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard
            title="Copy Transcript"
            content={result.text}
          />
          <Action.CopyToClipboard title="Copy as JSON" content={rawJson} />
        </ActionPanel>
      }
    />
  );
}

async function transcribe(keshaBin: string): Promise<State> {
  const items = await getSelectedFinderItems().catch(() => []);
  if (items.length === 0) {
    return {
      status: "error",
      message: "No file selected in Finder.",
      hint: "Select an audio file (ogg / mp3 / wav / m4a / flac / opus) in Finder, then run this command.",
    };
  }
  if (items.length > 1) {
    return {
      status: "error",
      message: "Multiple files selected.",
      hint: "This command transcribes one file at a time. Select a single audio file and try again.",
    };
  }

  const path = items[0].path;
  await showToast({
    style: Toast.Style.Animated,
    title: "Transcribing…",
    message: basename(path),
  });

  try {
    const { stdout } = await execFileAsync(keshaBin, ["--json", path], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as TranscribeResult[];
    if (!parsed.length) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No transcript returned",
      });
      return {
        status: "error",
        message: "`kesha --json` returned an empty array.",
      };
    }
    await showToast({
      style: Toast.Style.Success,
      title: "Transcribed",
      message: basename(path),
    });
    // Pre-stage on clipboard so a ⌘↩ dismiss keeps the transcript handy even
    // if the user doesn't explicitly hit the Copy action.
    await Clipboard.copy(parsed[0].text);
    return { status: "ok", result: parsed[0], rawJson: stdout };
  } catch (err: unknown) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Transcription failed",
    });
    const message = err instanceof Error ? err.message : String(err);
    const hint = message.includes("ENOENT")
      ? `The \`kesha\` CLI wasn't found. Install it with \`bun add --global @drakulavich/kesha-voice-kit\` and run \`kesha install\`, or set the binary path in this extension's preferences.`
      : undefined;
    return { status: "error", message, hint };
  }
}

function buildMarkdown(r: TranscribeResult): string {
  const lines: string[] = [];
  lines.push(`# ${basename(r.file)}`);
  lines.push("");
  lines.push(r.text);
  lines.push("");
  lines.push("---");
  const meta: string[] = [];
  const lang = r.textLanguage?.code ?? r.audioLanguage?.code ?? r.lang;
  const conf = r.textLanguage?.confidence ?? r.audioLanguage?.confidence;
  if (lang) {
    meta.push(
      conf != null
        ? `**Language:** \`${lang}\` (confidence ${conf.toFixed(2)})`
        : `**Language:** \`${lang}\``,
    );
  }
  if (r.sttTimeMs != null) {
    meta.push(`**STT time:** ${r.sttTimeMs} ms`);
  }
  lines.push(meta.join(" · "));
  return lines.join("\n");
}

use clap::CommandFactory;
use serde::Serialize;
use std::collections::BTreeMap;

use crate::errors::{Category, ErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    None,
    One(&'static str),
    AnyOf(&'static [&'static str]),
}

impl Serialize for Gate {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Gate::None => s.serialize_none(),
            Gate::One(f) => s.serialize_str(f),
            Gate::AnyOf(fs) => fs.serialize(s),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WhenUngated {
    Reject,
    Drop,
}

impl WhenUngated {
    fn is_reject(&self) -> bool {
        matches!(self, WhenUngated::Reject)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Engine,
    Cli,
    Both,
}

pub struct GateRow {
    pub command: &'static str,
    pub flag: &'static str,
    pub gate: Gate,
    pub requires: &'static [&'static str],
    pub conflicts: &'static [&'static str],
    pub when_ungated: WhenUngated,
    pub values: Option<&'static str>,
}

const fn row(command: &'static str, flag: &'static str, gate: Gate) -> GateRow {
    GateRow {
        command,
        flag,
        gate,
        requires: &[],
        conflicts: &[],
        when_ungated: WhenUngated::Reject,
        values: None,
    }
}

/// The only place a flag's feature gate is written down; `every_clap_flag_has_a_gate_row_and_vice_versa` keeps it equal to clap.
pub fn gate_rows() -> Vec<GateRow> {
    let mut rows = vec![
        row("transcribe", "json", Gate::None),
        GateRow {
            conflicts: &["no-vad"],
            ..row("transcribe", "vad", Gate::None)
        },
        GateRow {
            conflicts: &["vad"],
            ..row("transcribe", "no-vad", Gate::None)
        },
        GateRow {
            requires: &["json"],
            conflicts: &["no-vad"],
            ..row(
                "transcribe",
                "speakers",
                Gate::One(crate::transcribe::TRANSCRIBE_DIARIZE_FEATURE),
            )
        },
        row(
            "transcribe",
            "itn",
            Gate::One(crate::transcribe::TRANSCRIBE_ITN_FEATURE),
        ),
        GateRow {
            conflicts: &["live"],
            ..row("record", "out", Gate::None)
        },
        row(
            "record",
            "live",
            Gate::One(crate::record::RECORD_LIVE_FEATURE),
        ),
        row("record", "max-seconds", Gate::None),
        GateRow {
            requires: &["live"],
            ..row(
                "record",
                "auto-stop",
                Gate::One(crate::record::RECORD_LIVE_AUTO_STOP_FEATURE),
            )
        },
        GateRow {
            requires: &["auto-stop"],
            ..row(
                "record",
                "auto-stop-silence-ms",
                Gate::One(crate::record::RECORD_LIVE_AUTO_STOP_FEATURE),
            )
        },
        GateRow {
            requires: &["auto-stop"],
            ..row(
                "record",
                "auto-stop-threshold",
                Gate::One(crate::record::RECORD_LIVE_AUTO_STOP_FEATURE),
            )
        },
        GateRow {
            requires: &["auto-stop"],
            ..row(
                "record",
                "auto-stop-min-speech-ms",
                Gate::One(crate::record::RECORD_LIVE_AUTO_STOP_FEATURE),
            )
        },
        row("install", "no-cache", Gate::None),
        row("install", "vad", Gate::None),
        row("install", "no-warmup", Gate::None),
        GateRow {
            values: Some("langs"),
            ..row("install", "tts", Gate::One("tts"))
        },
        row(
            "install",
            "diarize",
            Gate::One(crate::transcribe::TRANSCRIBE_DIARIZE_FEATURE),
        ),
        row("say", "voice", Gate::One("tts")),
        row("say", "lang", Gate::One("tts")),
        row("say", "out", Gate::One("tts")),
        row("say", "rate", Gate::One("tts.prosody_rate")),
        row("say", "list-voices", Gate::One("tts")),
        row("say", "ssml", Gate::One("tts")),
        row("say", "format", Gate::One("tts")),
        row("say", "bitrate", Gate::One("tts")),
        row("say", "sample-rate", Gate::One("tts")),
        GateRow {
            requires: &["voice-file"],
            ..row("say", "model", Gate::One("tts"))
        },
        GateRow {
            requires: &["model"],
            ..row("say", "voice-file", Gate::One("tts"))
        },
        row("say", "stdin-loop", Gate::One("tts")),
        GateRow {
            when_ungated: WhenUngated::Drop,
            ..row(
                "say",
                "no-expand-abbrev",
                Gate::AnyOf(&["tts.ru_acronym_expansion", "tts.en_acronym_expansion"]),
            )
        },
    ];
    // clap only carries these flags on builds with the feature (`cli/install.rs`, `cli/say.rs`), and the parity test holds both ways.
    const TTS_BUILD: bool = cfg!(feature = "tts");
    const DIARIZE_BUILD: bool = cfg!(feature = "system_diarize");
    rows.retain(|r| match (r.command, r.flag) {
        ("say", _) | ("install", "tts") => TTS_BUILD,
        ("install", "diarize") => DIARIZE_BUILD,
        _ => true,
    });
    rows
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagSchema {
    pub gate: Gate,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    pub requires: &'static [&'static str],
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    pub conflicts: &'static [&'static str],
    #[serde(skip_serializing_if = "WhenUngated::is_reject")]
    pub when_ungated: WhenUngated,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<&'static str>,
}

#[derive(Serialize)]
pub struct CommandSchema {
    pub flags: BTreeMap<String, FlagSchema>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEntry {
    pub code: &'static str,
    pub title: &'static str,
    pub category: Category,
    pub retryable: bool,
    pub origin: Origin,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarnEntry {
    pub code: &'static str,
    pub title: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Describe {
    pub protocol_version: u32,
    pub backend: &'static str,
    pub profile: &'static str,
    pub commands: BTreeMap<String, CommandSchema>,
    pub features: Vec<&'static str>,
    pub errors: Vec<ErrorEntry>,
    pub warnings: Vec<WarnEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tts: Option<crate::capabilities::TtsCapabilities>,
}

/// Codes the TS wrapper raises on its own; the engine never emits them.
const CLI_ONLY: &[(&str, &str, Category, bool)] = &[
    (
        "E_ENGINE_SPAWN",
        "Engine binary not installed or failed to start",
        Category::Platform,
        false,
    ),
    (
        "E_ENGINE_PROTOCOL",
        "Engine speaks a protocol this CLI does not",
        Category::Platform,
        false,
    ),
    (
        "E_INSTALL_RACE",
        "Another install reached the same cache first",
        Category::Internal,
        true,
    ),
];

fn origin_of(code: ErrorCode) -> Origin {
    match code {
        ErrorCode::InputNotFound | ErrorCode::InvalidArg | ErrorCode::Internal => Origin::Both,
        _ => Origin::Engine,
    }
}

pub fn document() -> Describe {
    let caps = crate::capabilities::get_capabilities();
    let rows = gate_rows();
    let mut commands = BTreeMap::new();
    for sub in crate::cli::args::Cli::command().get_subcommands() {
        let flags = sub
            .get_arguments()
            .filter_map(|a| a.get_long())
            .map(|long| {
                let r = rows
                    .iter()
                    .find(|r| r.command == sub.get_name() && r.flag == long)
                    .unwrap_or_else(|| panic!("no gate row for {} --{long}", sub.get_name()));
                (
                    long.to_string(),
                    FlagSchema {
                        gate: r.gate,
                        requires: r.requires,
                        conflicts: r.conflicts,
                        when_ungated: r.when_ungated,
                        values: r.values,
                    },
                )
            })
            .collect();
        commands.insert(sub.get_name().to_string(), CommandSchema { flags });
    }
    let mut errors: Vec<ErrorEntry> = ErrorCode::ALL
        .iter()
        .map(|&c| ErrorEntry {
            code: c.as_str(),
            title: c.title(),
            category: c.category(),
            retryable: c.retryable(),
            origin: origin_of(c),
        })
        .collect();
    errors.extend(
        CLI_ONLY
            .iter()
            .map(|&(code, title, category, retryable)| ErrorEntry {
                code,
                title,
                category,
                retryable,
                origin: Origin::Cli,
            }),
    );
    Describe {
        protocol_version: 4,
        backend: caps.backend,
        profile: profile(),
        commands,
        features: caps.features,
        errors,
        warnings: crate::protocol::events::WARN_CODES
            .iter()
            .map(|&(code, title)| WarnEntry { code, title })
            .collect(),
        tts: caps.tts,
    }
}

fn profile() -> &'static str {
    if cfg!(feature = "coreml") {
        "darwin"
    } else {
        "portable"
    }
}

pub fn render() -> anyhow::Result<String> {
    Ok(serde_json::to_string(&document())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use std::collections::BTreeSet;

    fn clap_flags(cmd: &str) -> BTreeSet<String> {
        let root = crate::cli::args::Cli::command();
        let sub = root
            .get_subcommands()
            .find(|c| c.get_name() == cmd)
            .unwrap_or_else(|| panic!("no subcommand {cmd}"));
        sub.get_arguments()
            .filter_map(|a| a.get_long().map(str::to_string))
            .collect()
    }

    #[test]
    fn every_clap_flag_has_a_gate_row_and_vice_versa() {
        let root = crate::cli::args::Cli::command();
        for sub in root.get_subcommands() {
            let name = sub.get_name();
            let rows: BTreeSet<String> = gate_rows()
                .into_iter()
                .filter(|r| r.command == name)
                .map(|r| r.flag.to_string())
                .collect();
            assert_eq!(
                clap_flags(name),
                rows,
                "gate table drifted from clap for `{name}`"
            );
        }
        let known: BTreeSet<&str> = root.get_subcommands().map(|s| s.get_name()).collect();
        for r in gate_rows() {
            assert!(
                known.contains(r.command),
                "gate row for unknown command {}",
                r.command
            );
        }
    }

    #[test]
    fn document_shape_matches_protocol_v4() {
        let d = document();
        assert_eq!(d.protocol_version, 4);
        assert!(matches!(d.profile, "portable" | "darwin"));
        let speakers = &d.commands["transcribe"].flags["speakers"];
        assert_eq!(speakers.gate, Gate::One("transcribe.diarize"));
        assert_eq!(speakers.requires, &["json"]);
        let vad = &d.commands["transcribe"].flags["vad"];
        assert_eq!(vad.conflicts, &["no-vad"]);
        assert!(d.features.contains(&"transcribe"));
        #[cfg(feature = "tts")]
        {
            assert_eq!(d.commands["say"].flags["model"].requires, &["voice-file"]);
            assert_eq!(d.commands["say"].flags["voice-file"].requires, &["model"]);
        }
    }

    #[cfg(feature = "tts")]
    #[test]
    fn install_tts_flag_takes_language_values() {
        assert_eq!(
            document().commands["install"].flags["tts"].values,
            Some("langs")
        );
    }

    #[cfg(feature = "tts")]
    #[test]
    fn no_expand_abbrev_is_dropped_when_ungated() {
        let d = document();
        let f = &d.commands["say"].flags["no-expand-abbrev"];
        assert_eq!(
            f.gate,
            Gate::AnyOf(&["tts.ru_acronym_expansion", "tts.en_acronym_expansion"])
        );
        assert_eq!(f.when_ungated, WhenUngated::Drop);
        assert!(d.tts.is_some());
    }

    #[test]
    fn errors_carry_origin_and_exactly_three_retryable_codes() {
        let d = document();
        let retryable: Vec<&str> = d
            .errors
            .iter()
            .filter(|e| e.retryable)
            .map(|e| e.code)
            .collect();
        assert_eq!(
            retryable,
            vec!["E_MODEL_DOWNLOAD", "E_DIARIZE_TIMEOUT", "E_INSTALL_RACE"]
        );
        let origin = |c: &str| {
            d.errors
                .iter()
                .find(|e| e.code == c)
                .unwrap_or_else(|| panic!("{c} missing"))
                .origin
        };
        assert_eq!(origin("E_ENGINE_SPAWN"), Origin::Cli);
        assert_eq!(origin("E_ENGINE_PROTOCOL"), Origin::Cli);
        assert_eq!(origin("E_INSTALL_RACE"), Origin::Cli);
        assert_eq!(origin("E_INVALID_ARG"), Origin::Both);
        assert_eq!(origin("E_INPUT_NOT_FOUND"), Origin::Both);
        assert_eq!(origin("E_INTERNAL"), Origin::Both);
        assert_eq!(origin("E_MODEL_MISSING"), Origin::Engine);
        assert_eq!(d.errors.len(), crate::errors::ErrorCode::ALL.len() + 3);
    }

    #[test]
    fn describe_publishes_the_whole_warning_taxonomy() {
        let d = document();
        let published: Vec<(&str, &str)> = d.warnings.iter().map(|w| (w.code, w.title)).collect();
        assert_eq!(published, crate::protocol::events::WARN_CODES.to_vec());
        assert!(published.iter().any(|(c, _)| *c == "W_VAD_NOT_INSTALLED"));
    }

    #[test]
    fn warnings_serialize_as_code_and_title_objects() {
        let v: serde_json::Value = serde_json::from_str(&render().unwrap()).unwrap();
        let warnings = v["warnings"].as_array().expect("warnings array");
        assert_eq!(warnings.len(), crate::protocol::events::WARN_CODES.len());
        let generic = warnings
            .iter()
            .find(|w| w["code"] == "W_GENERIC")
            .expect("W_GENERIC published");
        assert!(generic["title"].as_str().is_some_and(|t| !t.is_empty()));
    }

    #[test]
    fn json_uses_camel_case_and_omits_reject_and_null_gates() {
        let s = render().unwrap();
        assert!(s.contains("\"protocolVersion\":4"));
        assert!(s.contains("\"whenUngated\":\"drop\"") || !cfg!(feature = "tts"));
        assert!(!s.contains("\"whenUngated\":\"reject\""));
        assert!(s.contains("\"gate\":null"));
    }
}

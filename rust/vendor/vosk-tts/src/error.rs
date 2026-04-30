//! Trimmed error type for the vendored runtime subset.
//!
//! Variants for HTTP/gRPC/zip have been removed — those code paths no
//! longer exist in this crate.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("Failed to load ONNX model: {0}")]
    OnnxModelLoad(#[source] ort::Error),

    #[error("Failed to read dictionary from {path}: {source}")]
    DictionaryRead {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to parse config.json: {0}")]
    ConfigParse(#[source] serde_json::Error),

    #[error("Failed to read config from {path}: {source}")]
    ConfigRead {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to load WordPiece vocab from {path}: {source}")]
    VocabRead {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to extract audio tensor: {0}")]
    AudioTensorExtract(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("ONNX runtime error: {0}")]
    OnnxRuntime(#[from] ort::Error),

    #[error("Regex error: {0}")]
    Regex(#[from] regex::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

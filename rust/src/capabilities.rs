use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub protocol_version: u32,
    pub backend: &'static str,
    pub features: Vec<&'static str>,
}

pub fn get_capabilities() -> Capabilities {
    let mut features = vec!["transcribe", "detect-lang"];

    #[cfg(target_os = "macos")]
    features.push("detect-text-lang");

    Capabilities {
        protocol_version: 2,
        backend: backend_name(),
        features,
    }
}

fn backend_name() -> &'static str {
    #[cfg(feature = "coreml")]
    { "coreml" }
    #[cfg(not(feature = "coreml"))]
    { "onnx" }
}

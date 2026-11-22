use std::sync::{Mutex, PoisonError};

use ort::environment::Environment;
use ort::session::{
    builder::{AutoDevicePolicy, SessionBuilder},
    Session,
};

/// ONNX Runtime allows one environment per process, ever: a second `ort::init().build()` fails, so it is kept here.
pub fn environment() -> ort::Result<Environment> {
    static ENV: Mutex<Option<Environment>> = Mutex::new(None);
    let mut env = ENV.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(env) = env.as_ref() {
        return Ok(env.clone());
    }
    let built = ort::init().build()?;
    *env = Some(built.clone());
    Ok(built)
}

/// ort defaults to `MaxEfficiency`, which on macOS runs models on CoreML; the Kokoro mini fails there (#1647).
pub fn session_builder() -> ort::Result<SessionBuilder> {
    Ok(Session::builder(&environment()?)?.with_auto_device(AutoDevicePolicy::PreferCPU)?)
}

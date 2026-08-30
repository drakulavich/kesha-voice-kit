//! No in-tree caller uses these through `models::`, so only an external crate notices them going private (#950).
//! Compiled, not executed, by `just verify-darwin-full` in rust-test.yml's `test (macos-14)` job — the body is only path references, so type-checking it IS the assertion; no nextest lane builds this feature set.

#![cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]

#[test]
fn staging_entry_points_stay_public() {
    let _: fn(&[&str], bool) -> anyhow::Result<()> = kesha_engine::models::stage_ane_kokoro_voices;
    let _: fn(&[&str], bool) -> anyhow::Result<()> =
        kesha_engine::models::stage_fluidaudio_kokoro_assets;
    let _: fn() -> anyhow::Result<()> = kesha_engine::models::purge_incomplete_ane_bundles;
}

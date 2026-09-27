/// The Cargo profile this Engine was built from, as `describe` reports it.
pub const PROFILE: &str = if cfg!(darwin_native) {
    "darwin"
} else {
    "portable"
};

#[cfg(test)]
mod tests {
    use super::PROFILE;

    #[test]
    fn profile_names_the_bundle_the_build_enabled() {
        if cfg!(feature = "darwin") {
            assert_eq!(PROFILE, "darwin");
        } else if cfg!(feature = "portable") {
            assert_eq!(PROFILE, "portable");
        }
    }
}

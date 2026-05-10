// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "kesha-diarize",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Pinned to an unreleased FluidAudio commit on `main` — no 0.2.x
        // tag exposes Diarizer / SortformerDiarizer yet. Spike (#199 T1)
        // validated this exact rev: API surface, model bundling, 2-speaker
        // output, 1 h latency, RU quality. MUST use the FULL SHA — short
        // SHAs make SwiftPM serialize a bogus `"branch"` key into
        // Package.resolved that breaks `swift package update`. Bump (and
        // re-run the spike) when upstream tags a release; `--list-models`
        // in main.swift bakes the short SHA so drift surfaces in --help.
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            revision: "ce59fb14b8b8978b196f6a34282e20ea6762d164"
        ),
    ],
    targets: [
        .executableTarget(
            name: "kesha-diarize",
            dependencies: ["FluidAudio"]
        )
    ]
)

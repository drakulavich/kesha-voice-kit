// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "kesha-diarize",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Pinned to a specific commit on main; FluidAudio has no 0.2.x release exposing
        // diarization yet. Bump the revision when upstream cuts a tagged release.
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            revision: "ce59fb1"
        ),
    ],
    targets: [
        .executableTarget(
            name: "kesha-diarize",
            dependencies: ["FluidAudio"]
        )
    ]
)

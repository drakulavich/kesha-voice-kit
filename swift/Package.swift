// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ParakeetCoreML",
    platforms: [
        .macOS(.v14),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.13.6"),
    ],
    targets: [
        .executableTarget(
            name: "ParakeetCoreML",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ]
        ),
    ]
)

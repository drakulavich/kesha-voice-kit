import FluidAudio
import Foundation

func writeToStderr(_ message: String) {
    FileHandle.standardError.write(Data(message.utf8))
}

func coreMLMarkerPath() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home
        .appendingPathComponent(".cache", isDirectory: true)
        .appendingPathComponent("parakeet", isDirectory: true)
        .appendingPathComponent("coreml", isDirectory: true)
        .appendingPathComponent("models-v3-installed", isDirectory: false)
        .path
}

func markCoreMLInstalled() throws {
    let markerPath = coreMLMarkerPath()
    let markerURL = URL(fileURLWithPath: markerPath)
    try FileManager.default.createDirectory(
        at: markerURL.deletingLastPathComponent(),
        withIntermediateDirectories: true,
        attributes: nil
    )
    let contents = "installed=\(ISO8601DateFormatter().string(from: Date()))\n"
    try contents.write(to: markerURL, atomically: true, encoding: .utf8)
}

let args = CommandLine.arguments

if args.contains("--check-install") {
    if FileManager.default.fileExists(atPath: coreMLMarkerPath()) {
        print("ready")
        exit(0)
    }

    writeToStderr("CoreML models are not installed.\n")
    exit(1)
}

// Download models only (no transcription)
if args.contains("--download-only") {
    do {
        writeToStderr("Downloading CoreML models...\n")
        let _ = try await AsrModels.downloadAndLoad(version: .v3)
        try markCoreMLInstalled()
        print("CoreML models downloaded and compiled.")
    } catch {
        writeToStderr("Error downloading models: \(error.localizedDescription)\n")
        exit(1)
    }
    exit(0)
}

guard args.count >= 2 else {
    writeToStderr("Usage: parakeet-coreml [--download-only] <audio-file-path>\n")
    exit(1)
}

let path = args[1]

guard FileManager.default.fileExists(atPath: path) else {
    writeToStderr("Error: file not found: \(path)\n")
    exit(1)
}

do {
    // Download and load Parakeet TDT v3 CoreML models
    let models = try await AsrModels.downloadAndLoad(version: .v3)
    try markCoreMLInstalled()

    // Initialize ASR manager
    let asrManager = AsrManager(config: .default)
    try await asrManager.loadModels(models)

    // Load and resample audio file to 16 kHz mono
    let samples = try AudioConverter().resampleAudioFile(path: path)

    // Transcribe
    let result = try await asrManager.transcribe(samples)

    // Output transcript to stdout
    print(result.text)
} catch {
    writeToStderr("Error: \(error.localizedDescription)\n")
    exit(1)
}

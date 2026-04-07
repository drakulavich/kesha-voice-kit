import FluidAudio
import Foundation

func writeToStderr(_ message: String) {
    FileHandle.standardError.write(Data(message.utf8))
}

guard CommandLine.arguments.count >= 2 else {
    writeToStderr("Usage: ParakeetCoreML <audio-file-path>\n")
    exit(1)
}

let path = CommandLine.arguments[1]

guard FileManager.default.fileExists(atPath: path) else {
    writeToStderr("Error: file not found: \(path)\n")
    exit(1)
}

do {
    // Download and load Parakeet TDT v3 CoreML models
    let models = try await AsrModels.downloadAndLoad(version: .v3)

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

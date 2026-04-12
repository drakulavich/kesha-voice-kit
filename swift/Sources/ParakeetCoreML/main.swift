import CoreML
import FluidAudio
import Foundation
import NaturalLanguage

func writeToStderr(_ message: String) {
    FileHandle.standardError.write(Data(message.utf8))
}

struct BinaryCapabilities: Encodable {
    struct SupportedCommands: Encodable {
        let checkInstall: Bool
        let downloadOnly: Bool
    }

    let protocolVersion: Int
    let installState: String
    let supportedCommands: SupportedCommands
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

func currentInstallState() -> String {
    FileManager.default.fileExists(atPath: coreMLMarkerPath()) ? "ready" : "models-missing"
}

func printCapabilitiesJSON() throws {
    let capabilities = BinaryCapabilities(
        protocolVersion: 1,
        installState: currentInstallState(),
        supportedCommands: .init(
            checkInstall: true,
            downloadOnly: true
        )
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(capabilities)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

let args = CommandLine.arguments

if args.contains("--capabilities-json") {
    do {
        try printCapabilitiesJSON()
        exit(0)
    } catch {
        writeToStderr("Error: failed to encode capabilities: \(error.localizedDescription)\n")
        exit(1)
    }
}

if args.contains("--check-install") {
    if currentInstallState() == "ready" {
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

// Detect language of text using NLLanguageRecognizer
if args.count >= 3, args[1] == "detect-text-lang" {
    let text = args[2]
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)

    var code = ""
    var confidence = 0.0

    if let dominant = recognizer.dominantLanguage {
        let hypotheses = recognizer.languageHypotheses(withMaximum: 1)
        code = dominant.rawValue
        confidence = hypotheses[dominant] ?? 0.0
    }

    let result: [String: Any] = ["code": code, "confidence": confidence]
    do {
        let jsonData = try JSONSerialization.data(
            withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(jsonData)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        writeToStderr("Error: failed to serialize JSON: \(error.localizedDescription)\n")
        exit(1)
    }
    exit(0)
}

// Detect spoken language from audio using CoreML ECAPA-TDNN model
if args.count >= 3, args[1] == "detect-lang" {
    let audioPath = args[2]

    guard FileManager.default.fileExists(atPath: audioPath) else {
        writeToStderr("Error: file not found: \(audioPath)\n")
        exit(1)
    }

    do {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let modelDir = home
            .appendingPathComponent(".cache", isDirectory: true)
            .appendingPathComponent("parakeet", isDirectory: true)
            .appendingPathComponent("lang-id", isDirectory: true)
            .appendingPathComponent("coreml", isDirectory: true)

        let modelPath = modelDir
            .appendingPathComponent("lang-id-ecapa.mlpackage", isDirectory: true)
        let labelsPath = modelDir
            .appendingPathComponent("labels.json", isDirectory: false)

        guard FileManager.default.fileExists(atPath: modelPath.path) else {
            writeToStderr(
                "Error: lang-id model not found at \(modelPath.path). Run 'parakeet install' first.\n"
            )
            exit(1)
        }

        guard FileManager.default.fileExists(atPath: labelsPath.path) else {
            writeToStderr("Error: labels.json not found at \(labelsPath.path).\n")
            exit(1)
        }

        // Load CoreML model
        let config = MLModelConfiguration()
        config.computeUnits = .all
        let compiledURL = try MLModel.compileModel(at: modelPath)
        let model = try MLModel(contentsOf: compiledURL, configuration: config)

        // Load and resample audio to 16kHz mono
        var samples = try AudioConverter().resampleAudioFile(path: audioPath)

        // Truncate to first 10 seconds (160000 samples at 16kHz)
        let maxSamples = 160_000
        if samples.count > maxSamples {
            samples = Array(samples.prefix(maxSamples))
        }

        // Create MLMultiArray input with shape [1, samples]
        let inputArray = try MLMultiArray(shape: [1, NSNumber(value: samples.count)], dataType: .float32)
        for i in 0..<samples.count {
            inputArray[[0, NSNumber(value: i)] as [NSNumber]] = NSNumber(value: samples[i])
        }

        // Run inference
        let inputFeatures = try MLDictionaryFeatureProvider(dictionary: ["input": inputArray])
        let prediction = try model.prediction(from: inputFeatures)

        guard let probsArray = prediction.featureValue(for: "language_probs")?.multiArrayValue else {
            writeToStderr("Error: model output 'language_probs' not found.\n")
            exit(1)
        }

        // Load labels
        let labelsData = try Data(contentsOf: labelsPath)
        guard let labels = try JSONSerialization.jsonObject(with: labelsData) as? [String] else {
            writeToStderr("Error: labels.json must be an array of strings.\n")
            exit(1)
        }

        // Find top prediction
        var bestIndex = 0
        var bestProb: Float = 0.0
        for i in 0..<probsArray.count {
            let prob = probsArray[i].floatValue
            if prob > bestProb {
                bestProb = prob
                bestIndex = i
            }
        }

        let code = bestIndex < labels.count ? labels[bestIndex] : ""
        let confidence = Double(bestProb)

        let result: [String: Any] = ["code": code, "confidence": confidence]
        let jsonData = try JSONSerialization.data(
            withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(jsonData)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        writeToStderr("Error: \(error.localizedDescription)\n")
        exit(1)
    }
    exit(0)
}

guard args.count >= 2 else {
    writeToStderr(
        "Usage: parakeet-coreml [--capabilities-json] [--check-install] [--download-only] <audio-file-path>\n"
            + "       parakeet-coreml detect-text-lang <text>\n"
            + "       parakeet-coreml detect-lang <audio-file-path>\n")
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

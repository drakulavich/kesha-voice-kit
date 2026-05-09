import Foundation
import FluidAudio

struct OutSpan: Encodable {
    let start: Double
    let end: Double
    let speaker: UInt32
}

struct Output: Encodable {
    let spans: [OutSpan]
}

func usage() -> Never {
    FileHandle.standardError.write(Data(
        "usage: kesha-diarize <wav-path> [<model-path>] | --list-models\n".utf8
    ))
    FileHandle.standardError.write(Data(
        "  Model path resolution order:\n  1) 2nd argv\n  2) KESHA_DIARIZE_MODEL_PATH env var\n".utf8
    ))
    exit(2)
}

let argv = CommandLine.arguments
if argv.count < 2 || argv.count > 3 { usage() }

let arg = argv[1]

if arg == "--list-models" {
    print("FluidAudio.SortformerDiarizer (FluidAudio rev ce59fb1)")
    exit(0)
}

let wavURL = URL(fileURLWithPath: arg)
guard FileManager.default.fileExists(atPath: wavURL.path) else {
    FileHandle.standardError.write(Data(
        "error: audio file not found: \(arg)\n".utf8
    ))
    exit(1)
}

// Model path: 2nd argv > env var > fail loudly.
let modelPathString: String
if argv.count == 3 {
    modelPathString = argv[2]
} else if let env = ProcessInfo.processInfo.environment["KESHA_DIARIZE_MODEL_PATH"] {
    modelPathString = env
} else {
    FileHandle.standardError.write(Data(
        "error: diarization model path required (2nd argv or KESHA_DIARIZE_MODEL_PATH env var)\n".utf8
    ))
    FileHandle.standardError.write(Data(
        "       see https://github.com/drakulavich/kesha-voice-kit/issues/199 for setup\n".utf8
    ))
    exit(1)
}

let modelURL = URL(fileURLWithPath: modelPathString)
guard FileManager.default.fileExists(atPath: modelURL.path) else {
    FileHandle.standardError.write(Data(
        "error: diarization model not found: \(modelPathString)\n".utf8
    ))
    exit(1)
}

// Run async pipeline synchronously. Sidecar is one-shot; await blocks main.
let semaphore = DispatchSemaphore(value: 0)
var resultErr: Error?
var timeline: DiarizerTimeline?

Task {
    defer { semaphore.signal() }
    do {
        let diarizer = SortformerDiarizer(
            config: SortformerConfig.default,
            timelineConfig: DiarizerTimelineConfig.sortformerDefault
        )
        try await diarizer.initialize(mainModelPath: modelURL)
        timeline = try diarizer.processComplete(
            audioFileURL: wavURL,
            keepingEnrolledSpeakers: nil,
            finalizeOnCompletion: true,
            progressCallback: nil
        )
    } catch {
        resultErr = error
    }
}
semaphore.wait()

if let err = resultErr {
    FileHandle.standardError.write(Data(
        "error: diarize failed: \(err)\n".utf8
    ))
    exit(1)
}

guard let tl = timeline else {
    FileHandle.standardError.write(Data("error: diarize returned no timeline\n".utf8))
    exit(1)
}

// Map DiarizerTimeline → spans. Verified against
// FluidAudio/Sources/FluidAudio/Diarizer/DiarizerTimeline.swift @ ce59fb1:
//   - `DiarizerTimeline.speakers: [Int: DiarizerSpeaker]` (no top-level segments array;
//     flatten across speakers).
//   - `DiarizerSpeaker.finalizedSegments: [DiarizerSegment]`.
//   - `DiarizerSegment.startTime` / `.endTime` are Float seconds (computed from frames),
//     `speakerIndex` is Int. `processComplete(finalizeOnCompletion: true)` promotes
//     all tentative segments to finalized before returning, so we only emit finalized.
let allSegments: [DiarizerSegment] = tl.speakers.values.flatMap { $0.finalizedSegments }
let sorted = allSegments.sorted { $0.startTime < $1.startTime }
let spans = sorted.map { seg in
    OutSpan(
        start: Double(seg.startTime),
        end: Double(seg.endTime),
        speaker: UInt32(max(0, seg.speakerIndex))
    )
}

let json = try JSONEncoder().encode(Output(spans: spans))
FileHandle.standardOutput.write(json)
FileHandle.standardOutput.write(Data("\n".utf8))
exit(0)

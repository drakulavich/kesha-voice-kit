// CLI helper for kesha-engine (#141): text on stdin / argv → WAV on stdout.
//
// Invoked by the Rust `avspeech` backend when a `macos-*` voice is selected.
// Emits mono float32 WAV (IEEE_FLOAT) at the voice's native sample rate
// (22050 Hz on every macOS voice we've tested). Stderr carries progress + errors.
//
// Usage:
//   say-avspeech <voiceId> [text]   # synthesize (stdin if text is omitted)
//   say-avspeech --list-voices      # print installed voices, one per line
//
// Key gotcha: AVSpeechSynthesizer.write(_:toBufferCallback:) delivers buffers
// on the main dispatch queue, so the CLI MUST pump the run loop. Semaphores
// hang. CFRunLoopRun / CFRunLoopStop is the only working pattern.

import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: say-avspeech <voiceID> [text — else stdin] | --list-voices\n".data(using: .utf8)!)
  exit(2)
}

// --list-voices mode: print `identifier|language|name`, one per line.
// Rust side strips the first field, prefixes with `macos-`, and merges into
// the global voice list.
if args[1] == "--list-voices" {
  for voice in AVSpeechSynthesisVoice.speechVoices() {
    print("\(voice.identifier)|\(voice.language)|\(voice.name)")
  }
  exit(0)
}

let voiceId = args[1]
let text: String
if args.count >= 3 {
  text = args[2]
} else {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  text = String(data: data, encoding: .utf8) ?? ""
}
guard !text.isEmpty else {
  FileHandle.standardError.write("empty text\n".data(using: .utf8)!)
  exit(2)
}

let synth = AVSpeechSynthesizer()
let utt = AVSpeechUtterance(string: text)
utt.voice = AVSpeechSynthesisVoice(identifier: voiceId) ?? AVSpeechSynthesisVoice(language: voiceId)
if utt.voice == nil {
  FileHandle.standardError.write("voice not found: \(voiceId)\n".data(using: .utf8)!)
  exit(2)
}

var samples: [Float] = []
var sampleRate: Double = 0
var channels: AVAudioChannelCount = 0
var timedOut = false

synth.write(utt) { buffer in
  guard let pcm = buffer as? AVAudioPCMBuffer else { return }
  if pcm.frameLength == 0 {
    CFRunLoopStop(CFRunLoopGetMain())
    return
  }
  sampleRate = pcm.format.sampleRate
  channels = pcm.format.channelCount
  guard let floatPtr = pcm.floatChannelData?[0] else { return }
  let count = Int(pcm.frameLength)
  samples.append(contentsOf: UnsafeBufferPointer(start: floatPtr, count: count))
}

// 15s wall-clock watchdog. The actual timeout body hops back to the main
// queue so every read/write of `timedOut` happens on one thread — keeps
// us out of Swift's data-race territory (CFRunLoopStop's happens-before
// semantics are enough in practice, but TSan and future compiler
// invariants don't rely on them). Setting the flag before stopping the
// run loop lets the post-loop check exit non-zero even if some buffers
// arrived first — a partial WAV on stdout is worse than none, because
// the Rust caller would treat it as success.
DispatchQueue.global().asyncAfter(deadline: .now() + 15) {
  DispatchQueue.main.async {
    FileHandle.standardError.write("timeout waiting for synthesis\n".data(using: .utf8)!)
    timedOut = true
    CFRunLoopStop(CFRunLoopGetMain())
  }
}
CFRunLoopRun()

if timedOut {
  exit(3)
}
guard !samples.isEmpty, sampleRate > 0, channels > 0 else {
  FileHandle.standardError.write("no samples produced\n".data(using: .utf8)!)
  exit(4)
}

// Minimal WAV-float32 encoder (mono). IEEE_FLOAT (wFormatTag = 3) so downstream
// consumers can read the stream without re-quantization. Matches the shape
// emitted by `tts::wav::encode_wav` in the Rust engine.
func appendLE32(_ v: UInt32, to data: inout Data) {
  var le = v.littleEndian
  withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
}
func appendLE16(_ v: UInt16, to data: inout Data) {
  var le = v.littleEndian
  withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
}

let bitsPerSample: UInt16 = 32
let bytesPerSample: UInt16 = bitsPerSample / 8
// We only collect channel 0 of whatever PCM buffer arrives (see the
// `write(_:toBufferCallback:)` closure above), so the WAV header declares
// mono regardless of the source buffer's channel count. This keeps the
// declared dataSize in sync with the bytes actually written if a future
// voice ever returns stereo.
let outChannels: UInt16 = 1
let dataSize = UInt32(samples.count) * UInt32(bytesPerSample) * UInt32(outChannels)
var wav = Data()
wav.append("RIFF".data(using: .ascii)!)
appendLE32(36 + dataSize, to: &wav)
wav.append("WAVE".data(using: .ascii)!)
wav.append("fmt ".data(using: .ascii)!)
appendLE32(16, to: &wav)
appendLE16(3, to: &wav)  // IEEE_FLOAT
appendLE16(outChannels, to: &wav)
appendLE32(UInt32(sampleRate), to: &wav)
appendLE32(UInt32(sampleRate) * UInt32(outChannels) * UInt32(bytesPerSample), to: &wav)
appendLE16(outChannels * bytesPerSample, to: &wav)
appendLE16(bitsPerSample, to: &wav)
wav.append("data".data(using: .ascii)!)
appendLE32(dataSize, to: &wav)

samples.withUnsafeBytes { raw in
  wav.append(raw.bindMemory(to: UInt8.self))
}

FileHandle.standardOutput.write(wav)

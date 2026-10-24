import Foundation
import WhisperKit

// Batch transcription of a recorded WAV, used to recover a session whose live
// transcription failed (network drop, crash) from the local audio backup.
//
//   oats-audio transcribe --input a.wav --model <variant> --models-dir <dir>
//                         [--language <code>] [--words 1] [--output out.json]
//     → { segments: [{ text, startMs, endMs, words?: [{w, s, e}] }] }

func rms(_ samples: [Float], from start: Float, to end: Float) -> Float {
    let a = max(0, min(samples.count, Int(start * Float(sampleRate))))
    let b = max(a, min(samples.count, Int(end * Float(sampleRate))))
    guard b > a else { return 0 }
    var sum: Float = 0
    for i in a ..< b { sum += samples[i] * samples[i] }
    return (sum / Float(b - a)).squareRoot()
}

func runTranscribe(_ f: [String: String]) async throws {
    let input = URL(fileURLWithPath: try requireFlag(f, "input"))
    guard FileManager.default.fileExists(atPath: input.path) else {
        throw CLIError(description: "input file not found: \(input.path)")
    }
    let variant = try requireFlag(f, "model")
    let base = URL(fileURLWithPath: try requireFlag(f, "models-dir"), isDirectory: true)
    let language = f["language"].flatMap { $0 == "multi" || $0.isEmpty ? nil : $0 }
    let words = f["words"] == "1"

    let whisper = try await makeWhisper(variant: variant, base: base, prewarm: false)
    let options = DecodingOptions(
        language: language,
        temperatureFallbackCount: 2,
        usePrefillPrompt: true,
        detectLanguage: language == nil,
        skipSpecialTokens: true,
        withoutTimestamps: false,
        wordTimestamps: words,
        suppressBlank: true,
        noSpeechThreshold: 0.6,
        chunkingStrategy: .vad
    )
    let audio = try AudioProcessor.loadAudioAsFloatArray(fromPath: input.path)
    let results = try await whisper.transcribe(audioArray: audio, decodeOptions: options)

    var segments: [[String: Any]] = []
    for segment in results.flatMap(\.segments) {
        // Whisper invents short phrases ("Thank you.") over silence; drop segments whose audio is silent.
        guard let text = clean(segment.text), rms(audio, from: segment.start, to: segment.end) > 0.004 else { continue }
        var out: [String: Any] = [
            "text": text,
            "startMs": Int(segment.start * 1000),
            "endMs": Int(segment.end * 1000),
        ]
        if words {
            var list: [[String: Any]] = []
            for w in segment.words ?? [] {
                let start: Int = Int(w.start * 1000)
                let end: Int = Int(w.end * 1000)
                list.append(["w": w.word, "s": start, "e": end])
            }
            out["words"] = list
        }
        segments.append(out)
    }

    let data = try JSONSerialization.data(withJSONObject: ["segments": segments])
    if let path = f["output"] {
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    } else {
        FileHandle.standardOutput.write(data + Data("\n".utf8))
    }
}

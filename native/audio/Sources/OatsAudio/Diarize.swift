import FluidAudio
import Foundation

// Offline speaker diarization.
//
// Built only on the open-source FluidAudio SDK (Apache-2.0) and its
// pyannote/WeSpeaker CoreML models:
//
//   oats-audio diarize --input a.wav [--max-speakers N] --output out.json
//     → { modelId, durationMs, segments: [{ speakerId, startMs, endMs }],
//         speakerEmbeddings: { speakerId: [Float] } }
//
//   oats-audio embed --input a.wav --output out.json
//     → { modelId, embedding, speechMs, speakerCount, dominantShare }
//
// Models are downloaded on first use into FluidAudio's cache directory.

let diarizerModelId = "FluidInference/speaker-diarization-coreml"

struct Segment: Encodable {
    let speakerId: String
    let startMs: Int
    let endMs: Int
}

struct DiarizeOutput: Encodable {
    let modelId: String
    let durationMs: Int
    let segments: [Segment]
    let speakerEmbeddings: [String: [Float]]
    let modelPrepMs: Int
}

struct EmbedOutput: Encodable {
    let modelId: String
    let embedding: [Float]
    let speechMs: Int
    let speakerCount: Int
    let dominantShare: Double
    let modelPrepMs: Int
}

struct DiarizeOptions {
    var command: String
    var input: URL
    var output: URL?
    var maxSpeakers: Int?
    var modelsDir: URL?

    static func parse(_ args: [String]) throws -> DiarizeOptions {
        guard let command = args.first, ["diarize", "embed"].contains(command) else {
            throw CLIError(description: usage)
        }
        var input: URL?
        var output: URL?
        var maxSpeakers: Int?
        var modelsDir: URL?
        var i = 1
        func value() throws -> String {
            i += 1
            guard i < args.count else { throw CLIError(description: "\(args[i - 1]) needs a value") }
            return args[i]
        }
        while i < args.count {
            switch args[i] {
            case "--input": input = URL(fileURLWithPath: try value())
            case "--output": output = URL(fileURLWithPath: try value())
            case "--models-dir": modelsDir = URL(fileURLWithPath: try value(), isDirectory: true)
            case "--max-speakers":
                guard let n = Int(try value()), n > 0 else {
                    throw CLIError(description: "--max-speakers must be a positive integer")
                }
                maxSpeakers = n
            default: throw CLIError(description: "unknown argument \(args[i])")
            }
            i += 1
        }
        guard let input else { throw CLIError(description: "--input is required") }
        guard FileManager.default.fileExists(atPath: input.path) else {
            throw CLIError(description: "input file not found: \(input.path)")
        }
        return DiarizeOptions(command: command, input: input, output: output, maxSpeakers: maxSpeakers, modelsDir: modelsDir)
    }
}

func ms(_ seconds: Float) -> Int { Int((seconds * 1000).rounded()) }

func diarize(_ opts: DiarizeOptions, maxSpeakers: Int?) async throws -> (DiarizationResult, durationMs: Int, prepMs: Int) {
    var config = OfflineDiarizerConfig()
    config.clustering.maxSpeakers = maxSpeakers
    let manager = OfflineDiarizerManager(config: config)

    let prepStart = Date()
    try await manager.prepareModels(directory: opts.modelsDir)
    let prepMs = Int(Date().timeIntervalSince(prepStart) * 1000)

    let samples = try AudioConverter().resampleAudioFile(opts.input)
    let durationMs = Int(Double(samples.count) / 16.0)
    guard !samples.isEmpty else { throw CLIError(description: "no speech detected in the audio") }
    let result = try await manager.process(audio: samples)
    guard !result.segments.isEmpty else { throw CLIError(description: "no speech detected in the audio") }
    return (result, durationMs, prepMs)
}

func runDiarization(_ args: [String]) async throws {
    let opts = try DiarizeOptions.parse(args)
    let encoder = JSONEncoder()
    let data: Data

    switch opts.command {
    case "diarize":
        let (result, durationMs, prepMs) = try await diarize(opts, maxSpeakers: opts.maxSpeakers)
        let output = DiarizeOutput(
            modelId: diarizerModelId,
            durationMs: durationMs,
            segments: result.segments
                .sorted { $0.startTimeSeconds < $1.startTimeSeconds }
                .map { Segment(speakerId: $0.speakerId, startMs: ms($0.startTimeSeconds), endMs: ms($0.endTimeSeconds)) },
            speakerEmbeddings: result.speakerDatabase ?? [:],
            modelPrepMs: prepMs
        )
        data = try encoder.encode(output)

    default: // embed: a voice sample that should mostly contain one speaker
        let (result, _, prepMs) = try await diarize(opts, maxSpeakers: nil)
        var speech: [String: Float] = [:]
        for s in result.segments { speech[s.speakerId, default: 0] += s.durationSeconds }
        let total = speech.values.reduce(0, +)
        guard let (dominant, dominantSeconds) = speech.max(by: { $0.value < $1.value }),
              let embedding = result.speakerDatabase?[dominant] ?? result.segments.first(where: { $0.speakerId == dominant })?.embedding
        else { throw CLIError(description: "no speech detected in the audio") }
        let output = EmbedOutput(
            modelId: diarizerModelId,
            embedding: embedding,
            speechMs: ms(total),
            speakerCount: speech.count,
            dominantShare: total > 0 ? Double(dominantSeconds / total) : 0,
            modelPrepMs: prepMs
        )
        data = try encoder.encode(output)
    }

    if let out = opts.output {
        try data.write(to: out, options: .atomic)
    } else {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

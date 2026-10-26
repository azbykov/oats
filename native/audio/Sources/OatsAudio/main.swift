import Foundation

// oats-audio: native audio sidecar for Oats.
//   diarize / embed   offline speaker separation (FluidAudio)      — Diarize.swift
//   prepare-asr       download + compile a Whisper model           — Listen.swift
//   prewarm-asr       compile a downloaded model (after an update) — Listen.swift
//   listen            streaming local transcription (WhisperKit)   — Listen.swift
//   transcribe        batch transcription of a recorded WAV        — Transcribe.swift
//   watch-mic         which apps are recording from the mic        — WatchMic.swift

struct CLIError: Error, CustomStringConvertible {
    let description: String
}

let usage = """
    usage:
      oats-audio diarize --input <wav> [--max-speakers N] [--output <json>] [--models-dir <dir>]
      oats-audio embed --input <wav> [--output <json>] [--models-dir <dir>]
      oats-audio prepare-asr --model <variant> --models-dir <dir>
      oats-audio prewarm-asr --model <variant> --models-dir <dir>
      oats-audio listen --model <variant> --models-dir <dir> [--language <code>] [--words-channels 1]
      oats-audio transcribe --input <wav> --model <variant> --models-dir <dir> [--language <code>] [--words 1] [--output <json>]
      oats-audio watch-mic
    """

/// Parses `--flag value` pairs after the subcommand.
func flags(_ args: ArraySlice<String>) throws -> [String: String] {
    var out: [String: String] = [:]
    var it = args.makeIterator()
    while let key = it.next() {
        guard key.hasPrefix("--"), let value = it.next() else { throw CLIError(description: "bad argument \(key)\n\(usage)") }
        out[String(key.dropFirst(2))] = value
    }
    return out
}

/// Writes one JSON object per line to stdout (the Electron main process reads these).
func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    switch args.first {
    case "diarize", "embed": try await runDiarization(args)
    case "prepare-asr": try await runPrepare(try flags(args.dropFirst()))
    case "prewarm-asr": try await runPrewarm(try flags(args.dropFirst()))
    case "listen": try await runListen(try flags(args.dropFirst()))
    case "transcribe": try await runTranscribe(try flags(args.dropFirst()))
    case "watch-mic": try await runWatchMic()
    default: throw CLIError(description: usage)
    }
} catch {
    FileHandle.standardError.write(Data("oats-audio: \(error)\n".utf8))
    exit(1)
}

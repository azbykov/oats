import Foundation
import WhisperKit

// Local streaming transcription with WhisperKit (MIT, CoreML on the Neural Engine).
//
// Whisper is not a streaming model, so `listen` segments each channel with a
// lightweight energy VAD: while someone is talking it re-transcribes the open
// utterance about once a second ("partial"), and when they pause it transcribes
// the whole utterance once more and commits it ("final").
//
// stdin  — binary frames: [kind u8][channel u8][length u32 LE][payload]
//            kind 1 audio: payload is 16 kHz mono Int16 LE PCM
//            kind 2 reset: a new recording session starts at t = 0 for this channel
//            kind 3 flush: the user stopped; finalise any open utterance
// stdout — JSON lines: {type: ready | partial | final | error, channel, text, startMs, endMs}
//          finals on channels listed in --words-channels also carry words:
//          [{w, s, e}] (ms) so the app can split a line at speaker changes

let sampleRate = 16_000
let whisperRepo = "argmaxinc/whisperkit-coreml"

/// Where `WhisperKit.download` (HubApi.snapshot) stores a model variant.
func modelFolder(_ variant: String, base: URL) -> URL {
    base.appending(path: "models").appending(path: whisperRepo).appending(path: variant)
}

func requireFlag(_ f: [String: String], _ name: String) throws -> String {
    guard let v = f[name], !v.isEmpty else { throw CLIError(description: "--\(name) is required") }
    return v
}

func makeWhisper(variant: String, base: URL, prewarm: Bool) async throws -> WhisperKit {
    let folder = modelFolder(variant, base: base)
    guard FileManager.default.fileExists(atPath: folder.path) else {
        throw CLIError(description: "model \(variant) is not downloaded")
    }
    let config = WhisperKitConfig(
        modelFolder: folder.path,
        tokenizerFolder: base,
        verbose: false,
        logLevel: .none,
        prewarm: prewarm,
        load: true,
        download: false
    )
    return try await WhisperKit(config)
}

// MARK: prepare-asr

func runPrepare(_ f: [String: String]) async throws {
    let variant = try requireFlag(f, "model")
    let base = URL(fileURLWithPath: try requireFlag(f, "models-dir"), isDirectory: true)
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)

    var lastReported = -1
    let folder = try await WhisperKit.download(variant: variant, downloadBase: base, from: whisperRepo) { progress in
        let pct = Int(progress.fractionCompleted * 100)
        if pct != lastReported {
            lastReported = pct
            emit(["type": "progress", "stage": "download", "fraction": progress.fractionCompleted])
        }
    }
    guard folder.standardizedFileURL.path == modelFolder(variant, base: base).standardizedFileURL.path else {
        throw CLIError(description: "unexpected model location \(folder.path)")
    }
    // First load compiles the CoreML models for this Mac and fetches the tokenizer;
    // doing it here keeps the first recording from stalling.
    emit(["type": "progress", "stage": "compile", "fraction": 1.0])
    _ = try await makeWhisper(variant: variant, base: base, prewarm: true)
    emit(["type": "ready", "modelFolder": folder.path])
}

// MARK: listen

/// Energy-based voice activity detection over 30 ms frames.
final class Channel {
    static let frame = 480
    static let preroll = 10 // frames kept before speech onset
    static let onsetFrames = 3
    static let endSilenceFrames = 23 // ~700 ms pause ends an utterance
    static let maxFrames = 20 * sampleRate / frame // force a cut after 20 s

    let id: UInt8
    var sessionSample = 0 // samples received this session
    var carry: [Float] = [] // incomplete frame
    var buffer: [Float] = [] // preroll or the open utterance
    var bufferStart = 0 // session sample index of buffer[0]
    var frameEnergy: [Float] = []
    var inSpeech = false
    var loudRun = 0
    var silentRun = 0
    var noiseFloor: Float = 0.002
    var lastPartialAt = Date.distantPast

    init(id: UInt8) { self.id = id }

    func reset() {
        sessionSample = 0
        carry = []
        buffer = []
        bufferStart = 0
        frameEnergy = []
        inSpeech = false
        loudRun = 0
        silentRun = 0
        lastPartialAt = .distantPast
    }

    /// Returns utterances that ended while consuming `samples`.
    func feed(_ samples: [Float]) -> [Utterance] {
        var done: [Utterance] = []
        carry += samples
        var offset = 0
        while carry.count - offset >= Channel.frame {
            let frame = Array(carry[offset ..< offset + Channel.frame])
            offset += Channel.frame
            if let u = consume(frame) { done.append(u) }
        }
        carry.removeFirst(offset)
        return done
    }

    private func consume(_ frame: [Float]) -> Utterance? {
        var sum: Float = 0
        for v in frame { sum += v * v }
        let rms = (sum / Float(frame.count)).squareRoot()
        // Speech must clear the room's noise floor; the low minimum keeps quiet
        // built-in mics (no gain control) from never triggering.
        let threshold = max(0.003, noiseFloor * 3)
        let loud = rms > threshold

        buffer += frame
        frameEnergy.append(rms)
        sessionSample += frame.count

        if !inSpeech {
            if !loud { noiseFloor = noiseFloor * 0.95 + rms * 0.05 }
            loudRun = loud ? loudRun + 1 : 0
            if loudRun >= Channel.onsetFrames {
                inSpeech = true
                silentRun = 0
            } else {
                trim(keepFrames: Channel.preroll + Channel.onsetFrames)
            }
            return nil
        }

        silentRun = loud ? 0 : silentRun + 1
        if silentRun >= Channel.endSilenceFrames {
            inSpeech = false
            loudRun = 0
            // Keep ~150 ms of the trailing silence so the last word isn't clipped.
            return cut(atFrame: frameEnergy.count - silentRun + 5)
        }
        if frameEnergy.count >= Channel.maxFrames {
            // Cut a long monologue at the quietest frame of the last 3 seconds.
            let window = 100
            let from = frameEnergy.count - window
            let quietest = (from ..< frameEnergy.count).min { frameEnergy[$0] < frameEnergy[$1] } ?? frameEnergy.count
            return cut(atFrame: quietest)
        }
        return nil
    }

    private func trim(keepFrames: Int) {
        let drop = frameEnergy.count - keepFrames
        guard drop > 0 else { return }
        buffer.removeFirst(drop * Channel.frame)
        frameEnergy.removeFirst(drop)
        bufferStart += drop * Channel.frame
    }

    private func cut(atFrame f: Int) -> Utterance {
        let end = min(f, frameEnergy.count) * Channel.frame
        let u = Utterance(channel: id, startSample: bufferStart, audio: Array(buffer[0 ..< end]), final: true)
        buffer.removeFirst(end)
        frameEnergy.removeFirst(min(f, frameEnergy.count))
        bufferStart += end
        return u
    }

    /// Open utterance so far, for a partial result.
    func snapshot() -> Utterance? {
        guard inSpeech, buffer.count >= sampleRate else { return nil }
        return Utterance(channel: id, startSample: bufferStart, audio: buffer, final: false)
    }

    /// Ends any open utterance (user pressed stop).
    func flush() -> Utterance? {
        defer {
            buffer = []
            frameEnergy = []
            bufferStart = sessionSample
            inSpeech = false
            loudRun = 0
        }
        guard inSpeech, !buffer.isEmpty else { return nil }
        return Utterance(channel: id, startSample: bufferStart, audio: buffer, final: true)
    }
}

struct Utterance: Sendable {
    let channel: UInt8
    let startSample: Int
    let audio: [Float]
    let final: Bool
}

/// Finals are processed in order; only the newest partial per channel is kept.
actor Jobs {
    private var finals: [Utterance] = []
    private var partials: [UInt8: Utterance] = [:]
    private(set) var closed = false

    func push(_ u: Utterance) {
        if u.final {
            finals.append(u)
            partials[u.channel] = nil
        } else {
            partials[u.channel] = u
        }
    }

    func take() -> Utterance? {
        if !finals.isEmpty { return finals.removeFirst() }
        if let key = partials.keys.sorted().first { return partials.removeValue(forKey: key) }
        return nil
    }

    func close() { closed = true }
    var idle: Bool { finals.isEmpty && partials.isEmpty }
}

// Whisper's well-known hallucinations on silence or music.
let hallucinations = [
    "продолжение следует", "субтитры", "редактор субтитров", "спасибо за просмотр", "подписывайтесь",
    "thank you for watching", "thanks for watching", "amara.org", "please subscribe",
]

func clean(_ text: String) -> String? {
    var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    t = t.replacingOccurrences(of: #"\[[^\]]*\]|\([^)]*\)"#, with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.rangeOfCharacter(from: .letters) != nil else { return nil }
    let lower = t.lowercased()
    if hallucinations.contains(where: { lower.contains($0) }) { return nil }
    return t
}

/// Reads framed messages from stdin on a background thread.
func stdinFrames() -> AsyncStream<(kind: UInt8, channel: UInt8, payload: Data)> {
    AsyncStream { continuation in
        Thread {
            let input = FileHandle.standardInput
            func read(_ n: Int) -> Data? {
                var data = Data()
                while data.count < n {
                    let chunk = input.readData(ofLength: n - data.count)
                    if chunk.isEmpty { return nil }
                    data += chunk
                }
                return data
            }
            while let header = read(6) {
                let kind = header[0]
                let channel = header[1]
                let length = Int(header[2]) | Int(header[3]) << 8 | Int(header[4]) << 16 | Int(header[5]) << 24
                guard let payload = length > 0 ? read(length) : Data() else { break }
                continuation.yield((kind, channel, payload))
            }
            continuation.finish()
        }.start()
    }
}

func runListen(_ f: [String: String]) async throws {
    let variant = try requireFlag(f, "model")
    let base = URL(fileURLWithPath: try requireFlag(f, "models-dir"), isDirectory: true)
    let language = f["language"].flatMap { $0 == "multi" || $0.isEmpty ? nil : $0 }
    // Word alignment costs extra decoder work, so only compute it where it's used.
    let wordChannels = Set((f["words-channels"] ?? "").split(separator: ",").compactMap { UInt8($0) })

    let whisper = try await makeWhisper(variant: variant, base: base, prewarm: false)
    let finalOptions = DecodingOptions(
        language: language,
        temperatureFallbackCount: 2,
        usePrefillPrompt: true,
        detectLanguage: language == nil,
        skipSpecialTokens: true,
        withoutTimestamps: true,
        suppressBlank: true,
        noSpeechThreshold: 0.6
    )
    var wordOptions = finalOptions
    wordOptions.withoutTimestamps = false
    wordOptions.wordTimestamps = true
    var partialOptions = finalOptions
    partialOptions.temperatureFallbackCount = 0

    let jobs = Jobs()
    emit(["type": "ready", "model": variant])

    let worker = Task {
        while true {
            guard let u = await jobs.take() else {
                if await jobs.closed { break }
                try? await Task.sleep(for: .milliseconds(40))
                continue
            }
            let results = (try? await whisper.transcribe(
                audioArray: u.audio,
                decodeOptions: !u.final ? partialOptions : wordChannels.contains(u.channel) ? wordOptions : finalOptions
            )) ?? []
            let text = clean(results.map(\.text).joined(separator: " "))
            var event: [String: Any] = [
                "type": u.final ? "final" : "partial",
                "channel": Int(u.channel),
                "text": text ?? "",
                "startMs": u.startSample * 1000 / sampleRate,
                "endMs": (u.startSample + u.audio.count) * 1000 / sampleRate,
            ]
            if let lang = results.first?.language { event["language"] = lang }
            if u.final, text != nil, wordChannels.contains(u.channel) {
                let offsetMs = u.startSample * 1000 / sampleRate
                var words: [[String: Any]] = []
                for segment in results.flatMap(\.segments) {
                    for w in segment.words ?? [] {
                        let start: Int = offsetMs + Int(w.start * 1000)
                        let end: Int = offsetMs + Int(w.end * 1000)
                        words.append(["w": w.word, "s": start, "e": end])
                    }
                }
                event["words"] = words
            }
            if u.final || text != nil { emit(event) }
        }
    }

    var channels: [UInt8: Channel] = [:]
    for await (kind, id, payload) in stdinFrames() {
        let channel = channels[id] ?? Channel(id: id)
        channels[id] = channel
        switch kind {
        case 1:
            let samples: [Float] = payload.withUnsafeBytes { raw in
                raw.bindMemory(to: Int16.self).map { Float(Int16(littleEndian: $0)) / 32768 }
            }
            for u in channel.feed(samples) { await jobs.push(u) }
            if Date().timeIntervalSince(channel.lastPartialAt) > 1.0, let snap = channel.snapshot() {
                channel.lastPartialAt = Date()
                await jobs.push(snap)
            }
        case 2:
            channel.reset()
        case 3:
            if let u = channel.flush() { await jobs.push(u) }
        default:
            break
        }
    }

    // stdin closed: finish what's queued, then exit.
    for channel in channels.values {
        if let u = channel.flush() { await jobs.push(u) }
    }
    await jobs.close()
    await worker.value
}

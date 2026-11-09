import CoreAudio
import Foundation

// Reports which apps are currently recording from an input device, so Oats can
// notice a Zoom/Teams/Meet call starting. Notion's desktop app does the same in
// its MicrophoneUsageMonitor (mac_utils.node) to offer AI meeting notes.
//
// It also says which input device each app records from, so Oats can open the
// same microphone as the call instead of the system default (plugging in a
// headset switches the default while Meet keeps the built-in mic).
//
//   oats-audio watch-mic
//     stdout — JSON line {type: "mic", apps: [{bundleId, pid, inputs: [{uid, name, source?}]}]}
//              on every change
//
// Uses the Core Audio process objects available since macOS 14.2.

private func property<T>(
    _ object: AudioObjectID,
    _ selector: AudioObjectPropertySelector,
    _ initial: T,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> T? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain
    )
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
    return status == noErr ? value : nil
}

/// An array-valued property (object ids), e.g. the process list or a process's devices.
private func objectList(
    _ object: AudioObjectID,
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

private func processObjects() -> [AudioObjectID] {
    objectList(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList)
}

private func string(
    _ object: AudioObjectID,
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
    return value.takeRetainedValue() as String
}

private func bundleId(_ object: AudioObjectID) -> String? {
    string(object, kAudioProcessPropertyBundleID)
}

/// An input device as Chromium will label it: the device name, or the selected
/// data source on devices that have them (older Macs' built-in input).
struct MicInput: Hashable {
    let uid: String
    let name: String
    let source: String?

    var json: [String: Any] {
        var out: [String: Any] = ["uid": uid, "name": name]
        if let source { out["source"] = source }
        return out
    }
}

private func hasInput(_ device: AudioObjectID) -> Bool {
    !objectList(device, kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput).isEmpty
}

private func sourceName(_ device: AudioObjectID) -> String? {
    guard var source = property(device, kAudioDevicePropertyDataSource, UInt32(0), scope: kAudioObjectPropertyScopeInput)
    else { return nil }
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDataSourceNameForIDCFString,
        mScope: kAudioObjectPropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var name: Unmanaged<CFString>?
    let status = withUnsafeMutablePointer(to: &source) { sourcePtr in
        withUnsafeMutablePointer(to: &name) { namePtr in
            var translation = AudioValueTranslation(
                mInputData: sourcePtr,
                mInputDataSize: UInt32(MemoryLayout<UInt32>.size),
                mOutputData: namePtr,
                mOutputDataSize: UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            )
            var size = UInt32(MemoryLayout<AudioValueTranslation>.size)
            return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &translation)
        }
    }
    guard status == noErr, let name else { return nil }
    return name.takeRetainedValue() as String
}

private func micInput(_ device: AudioObjectID) -> MicInput? {
    guard let uid = string(device, kAudioDevicePropertyDeviceUID), let name = string(device, kAudioObjectPropertyName)
    else { return nil }
    return MicInput(uid: uid, name: name, source: sourceName(device))
}

/// The input devices a process records from, real microphones first. Voice
/// processing (echo cancellation in Chrome, FaceTime, Zoom…) records through a
/// private aggregate device that no other app can open, so its input sub-devices
/// follow it as the fallback. Virtual devices (Teams' own audio device, Krisp,
/// BlackHole) go last: a call that also opens one still talks into the real mic.
private func inputs(of process: AudioObjectID) -> [MicInput] {
    var real: [MicInput] = []
    var virtual: [MicInput] = []
    func add(_ device: AudioObjectID) {
        guard let input = micInput(device) else { return }
        let transport = property(device, kAudioDevicePropertyTransportType, UInt32(0))
        if transport == kAudioDeviceTransportTypeVirtual { virtual.append(input) } else { real.append(input) }
    }
    for device in objectList(process, kAudioProcessPropertyDevices, scope: kAudioObjectPropertyScopeInput) {
        add(device)
        let transport = property(device, kAudioDevicePropertyTransportType, UInt32(0))
        guard transport == kAudioDeviceTransportTypeAggregate else { continue }
        for sub in objectList(device, kAudioAggregateDevicePropertyActiveSubDeviceList) where hasInput(sub) {
            add(sub)
        }
    }
    var seen = Set<String>()
    return (real + virtual).filter { seen.insert($0.uid).inserted }
}

struct MicUser: Hashable {
    let bundleId: String
    let pid: Int32
    let inputs: [MicInput]
}

func micUsers() -> Set<MicUser> {
    var users = Set<MicUser>()
    for object in processObjects() {
        guard property(object, kAudioProcessPropertyIsRunningInput, UInt32(0)) == 1 else { continue }
        let pid = property(object, kAudioProcessPropertyPID, pid_t(0)) ?? 0
        users.insert(MicUser(bundleId: bundleId(object) ?? "", pid: pid, inputs: inputs(of: object)))
    }
    return users
}

func runWatchMic() async throws {
    if #unavailable(macOS 14.2) {
        throw CLIError(description: "watch-mic needs macOS 14.2 or later")
    }
    var last: Set<MicUser>? = nil
    while true {
        let users = micUsers()
        if users != last {
            last = users
            let apps = users.sorted { $0.bundleId < $1.bundleId }.map {
                ["bundleId": $0.bundleId, "pid": Int($0.pid), "inputs": $0.inputs.map(\.json)] as [String: Any]
            }
            emit(["type": "mic", "apps": apps])
        }
        try await Task.sleep(for: .seconds(1))
    }
}

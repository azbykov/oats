import CoreAudio
import Foundation

// Reports which apps are currently recording from an input device, so Oats can
// notice a Zoom/Teams/Meet call starting. Notion's desktop app does the same in
// its MicrophoneUsageMonitor (mac_utils.node) to offer AI meeting notes.
//
//   oats-audio watch-mic
//     stdout — JSON line {type: "mic", apps: [{bundleId, pid}]} on every change
//
// Uses the Core Audio process objects available since macOS 14.2.

private func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
    return status == noErr ? value : nil
}

private func processObjects() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr,
          size > 0
    else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr
    else { return [] }
    return ids
}

private func bundleId(_ object: AudioObjectID) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioProcessPropertyBundleID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
    return value.takeRetainedValue() as String
}

struct MicUser: Hashable {
    let bundleId: String
    let pid: Int32
}

func micUsers() -> Set<MicUser> {
    var users = Set<MicUser>()
    for object in processObjects() {
        guard property(object, kAudioProcessPropertyIsRunningInput, UInt32(0)) == 1 else { continue }
        let pid = property(object, kAudioProcessPropertyPID, pid_t(0)) ?? 0
        users.insert(MicUser(bundleId: bundleId(object) ?? "", pid: pid))
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
            let apps = users.sorted { $0.bundleId < $1.bundleId }.map { ["bundleId": $0.bundleId, "pid": Int($0.pid)] as [String: Any] }
            emit(["type": "mic", "apps": apps])
        }
        try await Task.sleep(for: .seconds(1))
    }
}

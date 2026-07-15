/**
 * macOS Call Detector
 *
 * Long-running process that reports when the CAMERA or MICROPHONE is actively
 * in use by any app (i.e. you're in a call), via CoreMediaIO + CoreAudio
 * "device is running somewhere" property listeners. This is device-in-use
 * state (metadata) — NOT capture — so it needs no camera/mic permission.
 *
 * Emits newline-delimited JSON to stdout on every transition, e.g.:
 *   {"device":"camera","active":true}
 *   {"device":"microphone","active":false}
 * Plus a periodic heartbeat re-check in case a listener misses an event.
 *
 * Compile: swiftc -O macos-call-detector.swift -o macos-call-detector \
 *            -framework CoreMediaIO -framework CoreAudio -framework Foundation
 */

import CoreAudio
import CoreMediaIO
import Foundation

// MARK: - Output

func emit(device: String, active: Bool) {
    print("{\"device\":\"\(device)\",\"active\":\(active ? "true" : "false")}")
    fflush(stdout)
}

func emitError(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

// MARK: - Microphone (CoreAudio) ------------------------------------------------

var micPreviouslyActive = false
var inputDevices: [AudioDeviceID] = []

func getInputDevices() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    guard
        AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize) == noErr
    else { return [] }

    let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    guard count > 0 else { return [] }
    var devices = [AudioDeviceID](repeating: 0, count: count)
    guard
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &devices) == noErr
    else { return [] }

    return devices.filter { deviceID in
        var streamAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &streamAddress, 0, nil, &streamSize) == noErr,
            streamSize > 0
        else { return false }
        let bufferListPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
        defer { bufferListPtr.deallocate() }
        guard
            AudioObjectGetPropertyData(
                deviceID, &streamAddress, 0, nil, &streamSize, bufferListPtr) == noErr
        else { return false }
        let bufferList = bufferListPtr.pointee
        return bufferList.mNumberBuffers > 0 && bufferList.mBuffers.mNumberChannels > 0
    }
}

func isAudioDeviceRunning(_ deviceID: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var isRunning: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &isRunning) == noErr else {
        return false
    }
    return isRunning > 0
}

func isAnyMicRunning() -> Bool { inputDevices.contains(where: isAudioDeviceRunning) }

func checkMicState() {
    let active = isAnyMicRunning()
    if active != micPreviouslyActive {
        micPreviouslyActive = active
        emit(device: "microphone", active: active)
    }
}

let audioListener: AudioObjectPropertyListenerProc = { _, _, _, _ in
    checkMicState()
    return noErr
}

let audioDeviceListListener: AudioObjectPropertyListenerProc = { _, _, _, _ in
    let newDevices = getInputDevices()
    let added = Set(newDevices).subtracting(inputDevices)
    for id in added { registerAudioListener(on: id) }
    inputDevices = newDevices
    checkMicState()
    return noErr
}

func registerAudioListener(on deviceID: AudioDeviceID) {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    AudioObjectAddPropertyListener(deviceID, &address, audioListener, nil)
}

func registerMicListeners() {
    inputDevices = getInputDevices()
    for id in inputDevices { registerAudioListener(on: id) }
    var listAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    AudioObjectAddPropertyListener(
        AudioObjectID(kAudioObjectSystemObject), &listAddress, audioDeviceListListener, nil)
}

// MARK: - Camera (CoreMediaIO) --------------------------------------------------

var cameraPreviouslyActive = false
var cameraDevices: [CMIOObjectID] = []

func getCameraDevices() -> [CMIOObjectID] {
    var address = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    var dataSize: UInt32 = 0
    guard
        CMIOObjectGetPropertyDataSize(
            CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, &dataSize) == noErr
    else { return [] }

    let count = Int(dataSize) / MemoryLayout<CMIOObjectID>.size
    guard count > 0 else { return [] }
    var devices = [CMIOObjectID](repeating: 0, count: count)
    var used: UInt32 = 0
    guard
        CMIOObjectGetPropertyData(
            CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, dataSize, &used, &devices)
            == noErr
    else { return [] }
    return devices
}

func isCameraDeviceRunning(_ deviceID: CMIOObjectID) -> Bool {
    var address = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    var isRunning: UInt32 = 0
    var used: UInt32 = 0
    let size = UInt32(MemoryLayout<UInt32>.size)
    guard
        CMIOObjectGetPropertyData(deviceID, &address, 0, nil, size, &used, &isRunning) == noErr
    else { return false }
    return isRunning > 0
}

func isAnyCameraRunning() -> Bool { cameraDevices.contains(where: isCameraDeviceRunning) }

func checkCameraState() {
    let active = isAnyCameraRunning()
    if active != cameraPreviouslyActive {
        cameraPreviouslyActive = active
        emit(device: "camera", active: active)
    }
}

let cameraListener: CMIOObjectPropertyListenerProc = { _, _, _, _ in
    checkCameraState()
    return noErr
}

func registerCameraListener(on deviceID: CMIOObjectID) {
    var address = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    CMIOObjectAddPropertyListener(deviceID, &address, cameraListener, nil)
}

func registerCameraListeners() {
    cameraDevices = getCameraDevices()
    for id in cameraDevices { registerCameraListener(on: id) }
    // Hot-plug: re-scan on device-list changes.
    var listAddress = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
    )
    let deviceListListener: CMIOObjectPropertyListenerProc = { _, _, _, _ in
        let newDevices = getCameraDevices()
        let added = Set(newDevices).subtracting(cameraDevices)
        for id in added { registerCameraListener(on: id) }
        cameraDevices = newDevices
        checkCameraState()
        return noErr
    }
    CMIOObjectAddPropertyListener(
        CMIOObjectID(kCMIOObjectSystemObject), &listAddress, deviceListListener, nil)
}

// MARK: - Signals & Main --------------------------------------------------------

var signalSources: [DispatchSourceSignal] = []

func setupSignalHandlers() {
    for sig in [SIGTERM, SIGINT] as [Int32] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { exit(0) }
        source.resume()
        signalSources.append(source)
    }
}

setupSignalHandlers()
registerMicListeners()
registerCameraListeners()

// Emit initial state for both devices.
micPreviouslyActive = isAnyMicRunning()
emit(device: "microphone", active: micPreviouslyActive)
cameraPreviouslyActive = isAnyCameraRunning()
emit(device: "camera", active: cameraPreviouslyActive)

// Heartbeat safety net.
let heartbeat = DispatchSource.makeTimerSource(queue: .main)
heartbeat.schedule(deadline: .now() + 5, repeating: 5)
heartbeat.setEventHandler {
    checkMicState()
    checkCameraState()
}
heartbeat.resume()

CFRunLoopRun()

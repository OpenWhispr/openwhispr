/**
 * macOS Microphone Listener
 *
 * Long-running process that monitors microphone usage via CoreAudio property listeners.
 * Outputs MIC_ACTIVE / MIC_INACTIVE state transitions to stdout.
 *
 * Compile: swiftc -O macos-mic-listener.swift -o macos-mic-listener -framework CoreAudio -framework Foundation
 */

import CoreAudio
import Foundation

// MARK: - State

var previouslyActive = false
var inputDevices: [AudioDeviceID] = []

// MARK: - Output

func emit(_ message: String) {
    print(message)
    fflush(stdout)
}

func emitError(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

// MARK: - Device Enumeration

func getInputDevices() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    var dataSize: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &dataSize
    )
    guard status == noErr else {
        emitError("Failed to get device list size: \(status)")
        return []
    }

    let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    guard deviceCount > 0 else { return [] }

    var devices = [AudioDeviceID](repeating: 0, count: deviceCount)
    status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &dataSize,
        &devices
    )
    guard status == noErr else {
        emitError("Failed to get device list: \(status)")
        return []
    }

    // Filter to input devices by checking stream configuration for input scope
    return devices.filter { deviceID in
        var streamAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )

        var streamSize: UInt32 = 0
        let sizeStatus = AudioObjectGetPropertyDataSize(
            deviceID,
            &streamAddress,
            0,
            nil,
            &streamSize
        )
        guard sizeStatus == noErr, streamSize > 0 else { return false }

        let bufferListPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
        defer { bufferListPtr.deallocate() }

        let streamStatus = AudioObjectGetPropertyData(
            deviceID,
            &streamAddress,
            0,
            nil,
            &streamSize,
            bufferListPtr
        )
        guard streamStatus == noErr else { return false }

        let bufferList = bufferListPtr.pointee
        // Device has input channels if any buffer has channels
        return bufferList.mNumberBuffers > 0 && bufferList.mBuffers.mNumberChannels > 0
    }
}

// MARK: - Running State Check

func isDeviceRunning(_ deviceID: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var isRunning: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)

    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &isRunning)
    guard status == noErr else { return false }

    return isRunning > 0
}

func isAnyInputRunning() -> Bool {
    for device in inputDevices {
        if isDeviceRunning(device) {
            return true
        }
    }
    return false
}

// MARK: - State Change Handler

func checkAndEmitState() {
    let active = isAnyInputRunning()
    if active != previouslyActive {
        previouslyActive = active
        emit(active ? "MIC_ACTIVE" : "MIC_INACTIVE")
    }
}

// MARK: - Property Listener Callbacks

/// Callback for device running state changes (kAudioDevicePropertyDeviceIsRunningSomewhere)
let propertyListener: AudioObjectPropertyListenerProc = {
    (objectID: AudioObjectID,
     numberAddresses: UInt32,
     addresses: UnsafePointer<AudioObjectPropertyAddress>,
     clientData: UnsafeMutableRawPointer?) -> OSStatus in

    checkAndEmitState()
    return noErr
}

/// Callback for device list changes (kAudioHardwarePropertyDevices) — hot-plug support
let deviceListListener: AudioObjectPropertyListenerProc = {
    (objectID: AudioObjectID,
     numberAddresses: UInt32,
     addresses: UnsafePointer<AudioObjectPropertyAddress>,
     clientData: UnsafeMutableRawPointer?) -> OSStatus in

    let newDevices = getInputDevices()
    let previousDeviceSet = Set(inputDevices)
    let newDeviceSet = Set(newDevices)

    // Register listeners on newly added input devices
    let addedDevices = newDeviceSet.subtracting(previousDeviceSet)
    for deviceID in addedDevices {
        registerRunningListener(on: deviceID)
    }

    // Remove listeners from removed devices (best effort, device may already be gone)
    let removedDevices = previousDeviceSet.subtracting(newDeviceSet)
    for deviceID in removedDevices {
        removeRunningListener(from: deviceID)
    }

    inputDevices = newDevices

    // Re-check state since a removed device may have been the active one
    checkAndEmitState()

    return noErr
}

// MARK: - Listener Registration

func registerRunningListener(on deviceID: AudioDeviceID) {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    let status = AudioObjectAddPropertyListener(deviceID, &address, propertyListener, nil)
    if status != noErr {
        emitError("Warning: Failed to register listener on device \(deviceID): \(status)")
    }
}

func removeRunningListener(from deviceID: AudioDeviceID) {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    // Best effort — device may already be disconnected
    AudioObjectRemovePropertyListener(deviceID, &address, propertyListener, nil)
}

func registerListeners() {
    // Discover all current input devices
    inputDevices = getInputDevices()

    // Register running-state listener on each input device
    for deviceID in inputDevices {
        registerRunningListener(on: deviceID)
    }

    // Register device list change listener on the system object for hot-plug support
    var deviceListAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    let status = AudioObjectAddPropertyListener(
        AudioObjectID(kAudioObjectSystemObject),
        &deviceListAddress,
        deviceListListener,
        nil
    )
    if status != noErr {
        emitError("Failed to register device list listener: \(status)")
    }
}

func removeAllListeners() {
    // Remove running-state listeners from all tracked input devices
    for deviceID in inputDevices {
        removeRunningListener(from: deviceID)
    }

    // Remove device list listener
    var deviceListAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    AudioObjectRemovePropertyListener(
        AudioObjectID(kAudioObjectSystemObject),
        &deviceListAddress,
        deviceListListener,
        nil
    )
}

// MARK: - Signal Handling

func setupSignalHandlers() {
    let signals: [Int32] = [SIGTERM, SIGINT]

    for sig in signals {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler {
            removeAllListeners()
            exit(0)
        }
        source.resume()
        // Keep the source alive by storing it (otherwise ARC deallocates it)
        signalSources.append(source)
    }
}

var signalSources: [DispatchSourceSignal] = []

// MARK: - Main

setupSignalHandlers()
registerListeners()

// Emit initial state
let active = isAnyInputRunning()
previouslyActive = active
emit(active ? "MIC_ACTIVE" : "MIC_INACTIVE")

// Heartbeat: periodic check in case property listeners miss events
let heartbeatTimer = DispatchSource.makeTimerSource(queue: .main)
heartbeatTimer.schedule(deadline: .now() + 5, repeating: 5)
heartbeatTimer.setEventHandler {
    checkAndEmitState()
}
heartbeatTimer.resume()

// Keep the process alive
CFRunLoopRun()

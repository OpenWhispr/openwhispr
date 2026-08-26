/**
 * macOS Microphone Listener
 *
 * Uses CoreAudio process objects when available to emit PID-scoped microphone
 * transitions. Older systems fall back to aggregate device activity for the
 * meeting-start prompt only.
 *
 * Compile: swiftc -O macos-mic-listener.swift -o macos-mic-listener -framework CoreAudio -framework Foundation
 */

import CoreAudio
import Foundation

enum ListenerMode {
    case none
    case process
    case aggregate
}

var listenerMode = ListenerMode.none
var processObjectPids: [AudioObjectID: pid_t] = [:]
var activeInputPids: Set<pid_t> = []
var processListListenerRegistered = false
var inputDevices: [AudioDeviceID] = []
var previouslyAggregateActive = false
var signalSources: [DispatchSourceSignal] = []

func stringProperty(
    _ objectID: AudioObjectID,
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: CFString?
    var dataSize = UInt32(MemoryLayout<CFString?>.size)
    let status = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(objectID, &address, 0, nil, &dataSize, pointer)
    }
    return status == noErr ? value as String? : nil
}

func printDefaultInputDevice() -> Int32 {
    let systemObject = AudioObjectID(kAudioObjectSystemObject)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var deviceID = AudioDeviceID(kAudioObjectUnknown)
    var dataSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(
        systemObject,
        &address,
        0,
        nil,
        &dataSize,
        &deviceID
    )
    guard status == noErr, deviceID != kAudioObjectUnknown else {
        emitError("Failed to resolve the default input device: \(status)")
        return 1
    }

    guard let name = stringProperty(deviceID, selector: kAudioObjectPropertyName), !name.isEmpty else {
        emitError("Default input device has no readable name")
        return 1
    }
    let uid = stringProperty(deviceID, selector: kAudioDevicePropertyDeviceUID) ?? ""
    let payload: [String: String] = ["name": name, "id": uid]
    guard
        let data = try? JSONSerialization.data(withJSONObject: payload),
        let json = String(data: data, encoding: .utf8)
    else {
        emitError("Failed to encode the default input device")
        return 1
    }
    emit(json)
    return 0
}

func emit(_ message: String) {
    print(message)
    fflush(stdout)
}

func emitError(_ message: String) {
    guard let data = (message + "\n").data(using: .utf8) else { return }
    FileHandle.standardError.write(data)
}

func processPropertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

func getProcessObjects() -> [AudioObjectID]? {
    let systemObject = AudioObjectID(kAudioObjectSystemObject)
    var address = processPropertyAddress(kAudioHardwarePropertyProcessObjectList)
    guard AudioObjectHasProperty(systemObject, &address) else { return nil }

    var dataSize: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &dataSize)
    guard status == noErr else { return nil }
    guard dataSize > 0 else { return [] }

    let objectCount = Int(dataSize) / MemoryLayout<AudioObjectID>.size
    var processObjects = [AudioObjectID](repeating: 0, count: objectCount)
    status = AudioObjectGetPropertyData(
        systemObject,
        &address,
        0,
        nil,
        &dataSize,
        &processObjects
    )
    return status == noErr ? processObjects : nil
}

func getProcessPid(_ processObject: AudioObjectID) -> pid_t? {
    var address = processPropertyAddress(kAudioProcessPropertyPID)
    var processId: pid_t = 0
    var dataSize = UInt32(MemoryLayout<pid_t>.size)
    let status = AudioObjectGetPropertyData(
        processObject,
        &address,
        0,
        nil,
        &dataSize,
        &processId
    )
    return status == noErr && processId > 0 ? processId : nil
}

func isProcessRunningInput(_ processObject: AudioObjectID) -> Bool? {
    var address = processPropertyAddress(kAudioProcessPropertyIsRunningInput)
    guard AudioObjectHasProperty(processObject, &address) else { return nil }

    var isRunning: UInt32 = 0
    var dataSize = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(
        processObject,
        &address,
        0,
        nil,
        &dataSize,
        &isRunning
    )
    return status == noErr ? isRunning > 0 : nil
}

let processStateListener: AudioObjectPropertyListenerProc = {
    (_: AudioObjectID,
     _: UInt32,
     _: UnsafePointer<AudioObjectPropertyAddress>,
     _: UnsafeMutableRawPointer?) -> OSStatus in

    DispatchQueue.main.async {
        reconcileProcessMonitoring()
    }
    return noErr
}

let processListListener: AudioObjectPropertyListenerProc = {
    (_: AudioObjectID,
     _: UInt32,
     _: UnsafePointer<AudioObjectPropertyAddress>,
     _: UnsafeMutableRawPointer?) -> OSStatus in

    DispatchQueue.main.async {
        reconcileProcessMonitoring()
    }
    return noErr
}

func addProcessStateListener(_ processObject: AudioObjectID) -> Bool {
    var address = processPropertyAddress(kAudioProcessPropertyIsRunningInput)
    return AudioObjectAddPropertyListener(
        processObject,
        &address,
        processStateListener,
        nil
    ) == noErr
}

func removeProcessStateListener(_ processObject: AudioObjectID) {
    var address = processPropertyAddress(kAudioProcessPropertyIsRunningInput)
    AudioObjectRemovePropertyListener(processObject, &address, processStateListener, nil)
}

func removeProcessMonitoring() {
    for processObject in processObjectPids.keys {
        removeProcessStateListener(processObject)
    }
    processObjectPids.removeAll()
    activeInputPids.removeAll()

    if processListListenerRegistered {
        var address = processPropertyAddress(kAudioHardwarePropertyProcessObjectList)
        AudioObjectRemovePropertyListener(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            processListListener,
            nil
        )
        processListListenerRegistered = false
    }
}

// A process can vanish between enumeration and the per-object property
// queries, so a failing object is skipped (treated as no longer capturing)
// rather than abandoning PID mode. Returns nil only when a non-empty process
// list yields no readable object at all — a systemic failure where reported
// state could no longer be trusted.
func prepareProcessSnapshot(
    _ processObjects: [AudioObjectID]
) -> (pids: [AudioObjectID: pid_t], active: Set<pid_t>)? {
    var pids: [AudioObjectID: pid_t] = [:]
    var active: Set<pid_t> = []

    for processObject in processObjects {
        guard
            let processId = getProcessPid(processObject),
            let isRunningInput = isProcessRunningInput(processObject)
        else {
            continue
        }

        pids[processObject] = processId
        if isRunningInput {
            active.insert(processId)
        }
    }

    if !processObjects.isEmpty && pids.isEmpty {
        return nil
    }
    return (pids, active)
}

func startProcessMonitoring() -> Bool {
    let systemObject = AudioObjectID(kAudioObjectSystemObject)
    var listAddress = processPropertyAddress(kAudioHardwarePropertyProcessObjectList)
    guard AudioObjectHasProperty(systemObject, &listAddress) else { return false }

    guard AudioObjectAddPropertyListener(
        systemObject,
        &listAddress,
        processListListener,
        nil
    ) == noErr else {
        return false
    }
    processListListenerRegistered = true

    guard
        let processObjects = getProcessObjects(),
        let snapshot = prepareProcessSnapshot(processObjects)
    else {
        removeProcessMonitoring()
        return false
    }

    for processObject in snapshot.pids.keys {
        guard addProcessStateListener(processObject) else {
            removeProcessMonitoring()
            return false
        }
        processObjectPids[processObject] = snapshot.pids[processObject]
    }
    activeInputPids = snapshot.active
    return true
}

func reconcileProcessMonitoring() {
    guard listenerMode == .process else { return }
    guard
        let processObjects = getProcessObjects(),
        var snapshot = prepareProcessSnapshot(processObjects)
    else {
        startAggregateFallback()
        return
    }

    let nextObjects = Set(snapshot.pids.keys)
    let previousObjects = Set(processObjectPids.keys)

    for processObject in previousObjects.subtracting(nextObjects) {
        removeProcessStateListener(processObject)
        processObjectPids.removeValue(forKey: processObject)
    }
    for processObject in nextObjects.subtracting(previousObjects) {
        // Registration can lose the same vanish race as the snapshot; drop the
        // object and let the next reconcile retry if it is actually alive. Its
        // pid stays in the active set until then so a live capture is never
        // reported stopped early.
        guard addProcessStateListener(processObject) else {
            snapshot.pids.removeValue(forKey: processObject)
            continue
        }
        processObjectPids[processObject] = snapshot.pids[processObject]
    }

    let stoppedPids = activeInputPids.subtracting(snapshot.active)
    let startedPids = snapshot.active.subtracting(activeInputPids)
    processObjectPids = snapshot.pids
    activeInputPids = snapshot.active

    for processId in stoppedPids.sorted() {
        emit("MIC_STOP \(processId)")
    }
    for processId in startedPids.sorted() {
        emit("MIC_START \(processId)")
    }
}

func getInputDevices() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let systemObject = AudioObjectID(kAudioObjectSystemObject)
    var dataSize: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &dataSize)
    guard status == noErr else { return [] }

    let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    guard deviceCount > 0 else { return [] }

    var devices = [AudioDeviceID](repeating: 0, count: deviceCount)
    status = AudioObjectGetPropertyData(systemObject, &address, 0, nil, &dataSize, &devices)
    guard status == noErr else { return [] }

    return devices.filter { deviceID in
        var streamAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            deviceID,
            &streamAddress,
            0,
            nil,
            &streamSize
        ) == noErr, streamSize > 0 else {
            return false
        }

        let bufferList = UnsafeMutableRawPointer.allocate(
            byteCount: Int(streamSize),
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { bufferList.deallocate() }
        guard AudioObjectGetPropertyData(
            deviceID,
            &streamAddress,
            0,
            nil,
            &streamSize,
            bufferList
        ) == noErr else {
            return false
        }

        let audioBufferList = bufferList.assumingMemoryBound(to: AudioBufferList.self).pointee
        return audioBufferList.mNumberBuffers > 0 && audioBufferList.mBuffers.mNumberChannels > 0
    }
}

func isDeviceRunning(_ deviceID: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var isRunning: UInt32 = 0
    var dataSize = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(
        deviceID,
        &address,
        0,
        nil,
        &dataSize,
        &isRunning
    ) == noErr && isRunning > 0
}

func isAnyInputRunning() -> Bool {
    inputDevices.contains(where: isDeviceRunning)
}

func checkAndEmitAggregateState() {
    let active = isAnyInputRunning()
    if active != previouslyAggregateActive {
        previouslyAggregateActive = active
        emit(active ? "MIC_ACTIVE" : "MIC_INACTIVE")
    }
}

let aggregateStateListener: AudioObjectPropertyListenerProc = {
    (_: AudioObjectID,
     _: UInt32,
     _: UnsafePointer<AudioObjectPropertyAddress>,
     _: UnsafeMutableRawPointer?) -> OSStatus in

    DispatchQueue.main.async {
        checkAndEmitAggregateState()
    }
    return noErr
}

let deviceListListener: AudioObjectPropertyListenerProc = {
    (_: AudioObjectID,
     _: UInt32,
     _: UnsafePointer<AudioObjectPropertyAddress>,
     _: UnsafeMutableRawPointer?) -> OSStatus in

    DispatchQueue.main.async {
        let newDevices = getInputDevices()
        let previousDeviceSet = Set(inputDevices)
        let newDeviceSet = Set(newDevices)

        for deviceID in newDeviceSet.subtracting(previousDeviceSet) {
            registerAggregateStateListener(on: deviceID)
        }
        for deviceID in previousDeviceSet.subtracting(newDeviceSet) {
            removeAggregateStateListener(from: deviceID)
        }

        inputDevices = newDevices
        checkAndEmitAggregateState()
    }
    return noErr
}

func registerAggregateStateListener(on deviceID: AudioDeviceID) {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectAddPropertyListener(deviceID, &address, aggregateStateListener, nil)
    if status != noErr {
        emitError("Warning: Failed to register listener on device \(deviceID): \(status)")
    }
}

func removeAggregateStateListener(from deviceID: AudioDeviceID) {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    AudioObjectRemovePropertyListener(deviceID, &address, aggregateStateListener, nil)
}

func registerAggregateMonitoring() {
    inputDevices = getInputDevices()
    for deviceID in inputDevices {
        registerAggregateStateListener(on: deviceID)
    }

    var listAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectAddPropertyListener(
        AudioObjectID(kAudioObjectSystemObject),
        &listAddress,
        deviceListListener,
        nil
    )
    if status != noErr {
        emitError("Failed to register device list listener: \(status)")
    }
}

func removeAggregateMonitoring() {
    for deviceID in inputDevices {
        removeAggregateStateListener(from: deviceID)
    }
    inputDevices.removeAll()

    var listAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    AudioObjectRemovePropertyListener(
        AudioObjectID(kAudioObjectSystemObject),
        &listAddress,
        deviceListListener,
        nil
    )
}

func startAggregateFallback() {
    if listenerMode == .process || processListListenerRegistered {
        removeProcessMonitoring()
    }
    if listenerMode != .aggregate {
        listenerMode = .aggregate
        registerAggregateMonitoring()
    }

    previouslyAggregateActive = isAnyInputRunning()
    emit("CAPABILITY AGGREGATE")
    emit(previouslyAggregateActive ? "MIC_ACTIVE" : "MIC_INACTIVE")
}

func removeAllListeners() {
    switch listenerMode {
    case .process:
        removeProcessMonitoring()
    case .aggregate:
        removeAggregateMonitoring()
    case .none:
        break
    }
}

func setupSignalHandlers() {
    for signalNumber in [SIGTERM, SIGINT] {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            removeAllListeners()
            exit(0)
        }
        source.resume()
        signalSources.append(source)
    }
}

if CommandLine.arguments.contains("--print-default-input") {
    exit(printDefaultInputDevice())
}

setupSignalHandlers()
if startProcessMonitoring() {
    listenerMode = .process
    emit("CAPABILITY PID")
    for processId in activeInputPids.sorted() {
        emit("MIC_START \(processId)")
    }
} else {
    startAggregateFallback()
}

let heartbeatTimer = DispatchSource.makeTimerSource(queue: .main)
heartbeatTimer.schedule(deadline: .now() + 5, repeating: 5)
heartbeatTimer.setEventHandler {
    switch listenerMode {
    case .process:
        reconcileProcessMonitoring()
    case .aggregate:
        checkAndEmitAggregateState()
    case .none:
        break
    }
}
heartbeatTimer.resume()

CFRunLoopRun()

import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

@available(macOS 14.2, *)
struct Config {
    let sampleRate: Double
    let chunkMilliseconds: Int
}

@available(macOS 14.2, *)
final class AudioTapCapture {
    private let config: Config
    private let targetFormat: AVAudioFormat
    private let chunkBytes: Int
    private let ioQueue = DispatchQueue(label: "com.openwhispr.audio-tap")

    private var tapID: AudioObjectID = 0
    private var aggregateDeviceID: AudioObjectID = 0
    private var ioProcID: AudioDeviceIOProcID?
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private var pendingPCM = Data()
    private var stopping = false

    init(config: Config) {
        self.config = config
        self.targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: config.sampleRate,
            channels: 1,
            interleaved: true
        )!
        self.chunkBytes = max(2, Int(config.sampleRate * Double(config.chunkMilliseconds) / 1000.0) * 2)
    }

    func start() throws {
        let tapDescription = CATapDescription()
        tapDescription.name = "openwhispr-audio-tap"
        tapDescription.uuid = UUID()
        tapDescription.processes = []
        tapDescription.isMono = true
        tapDescription.isExclusive = true
        tapDescription.isMixdown = true
        tapDescription.isPrivate = true
        tapDescription.muteBehavior = .unmuted

        var newTapID = AudioObjectID()
        var status = AudioHardwareCreateProcessTap(tapDescription, &newTapID)
        guard status == noErr else {
            throw makeError("Failed to create process tap", status: status, operation: "create_process_tap")
        }
        tapID = newTapID

        let tapUID = try getTapUID()
        try createAggregateDevice(tapUID: tapUID)
        try waitForAggregateDeviceReady()
        try configureConverter()
        try registerIOProc()

        status = AudioDeviceStart(aggregateDeviceID, ioProcID)
        guard status == noErr else {
            throw makeError("Failed to start aggregate device", status: status, operation: "start_device")
        }

        emit(event: [
            "type": "start",
            "sampleRate": Int(config.sampleRate),
            "channels": 1,
            "bitsPerChannel": 16,
        ])
    }

    func stop() {
        if stopping {
            return
        }
        stopping = true

        if aggregateDeviceID != 0 {
            AudioDeviceStop(aggregateDeviceID, ioProcID)
        }
        if let ioProcID {
            AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
            self.ioProcID = nil
        }
        if aggregateDeviceID != 0 {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = 0
        }
        if tapID != 0 {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = 0
        }

        flushPendingPCM()
        emit(event: ["type": "stop"])
    }

    private func createAggregateDevice(tapUID: String) throws {
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "OpenWhispr Audio Tap",
            kAudioAggregateDeviceUIDKey: "com.openwhispr.audio-tap.\(UUID().uuidString)",
            kAudioAggregateDeviceSubDeviceListKey: [],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID]],
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
        ]

        var deviceID = AudioObjectID()
        let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &deviceID)
        guard status == noErr else {
            throw makeError("Failed to create aggregate device", status: status, operation: "create_aggregate_device")
        }
        aggregateDeviceID = deviceID
    }

    private func waitForAggregateDeviceReady() throws {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        for _ in 0..<20 {
            var isAlive: UInt32 = 0
            var dataSize = UInt32(MemoryLayout<UInt32>.size)
            let status = AudioObjectGetPropertyData(
                aggregateDeviceID,
                &address,
                0,
                nil,
                &dataSize,
                &isAlive
            )
            if status == noErr, isAlive != 0 {
                return
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        throw makeError("Aggregate device did not become ready", operation: "wait_for_device")
    }

    private func configureConverter() throws {
        var asbd = AudioStreamBasicDescription()
        var dataSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &dataSize, &asbd)
        guard status == noErr else {
            throw makeError("Failed to get tap format", status: status, operation: "get_tap_format")
        }

        guard let sourceFormat = AVAudioFormat(streamDescription: &asbd) else {
            throw makeError("Failed to build source audio format", operation: "source_format")
        }
        guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
            throw makeError("Failed to create audio converter", operation: "create_converter")
        }

        self.sourceFormat = sourceFormat
        self.converter = converter
    }

    private func registerIOProc() throws {
        guard let sourceFormat, let converter else {
            throw makeError("Audio converter is not configured", operation: "register_ioproc")
        }

        var procID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcIDWithBlock(
            &procID,
            aggregateDeviceID,
            ioQueue
        ) { [weak self] _, inputData, _, _, _ in
            guard let self, !self.stopping else {
                return
            }
            self.processInput(inputData, sourceFormat: sourceFormat, converter: converter)
        }

        guard status == noErr, let procID else {
            throw makeError("Failed to create IO proc", status: status, operation: "create_ioproc")
        }

        ioProcID = procID
    }

    private func processInput(
        _ inputData: UnsafePointer<AudioBufferList>,
        sourceFormat: AVAudioFormat,
        converter: AVAudioConverter
    ) {
        let inputBufferList = UnsafeMutablePointer(mutating: inputData)
        guard
            let sourceBuffer = AVAudioPCMBuffer(
                pcmFormat: sourceFormat,
                bufferListNoCopy: inputBufferList,
                deallocator: nil
            )
        else {
            return
        }

        let sourceRate = max(sourceFormat.sampleRate, 1)
        let targetCapacity = AVAudioFrameCount(
            ceil(Double(sourceBuffer.frameLength) * targetFormat.sampleRate / sourceRate)
        ) + 32

        guard
            let outputBuffer = AVAudioPCMBuffer(
                pcmFormat: targetFormat,
                frameCapacity: max(targetCapacity, 32)
            )
        else {
            return
        }

        var didProvideInput = false
        var error: NSError?
        let status = converter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if didProvideInput {
                outStatus.pointee = .noDataNow
                return nil
            }
            didProvideInput = true
            outStatus.pointee = .haveData
            return sourceBuffer
        }

        if let error {
            emit(event: [
                "type": "error",
                "code": "convert_failed",
                "message": error.localizedDescription,
            ])
            return
        }

        guard status == .haveData || status == .inputRanDry else {
            return
        }

        let audioBuffer = outputBuffer.audioBufferList.pointee.mBuffers
        guard let data = audioBuffer.mData, audioBuffer.mDataByteSize > 0 else {
            return
        }

        pendingPCM.append(data.assumingMemoryBound(to: UInt8.self), count: Int(audioBuffer.mDataByteSize))
        flushFullChunks()
    }

    private func flushFullChunks() {
        while pendingPCM.count >= chunkBytes {
            let chunk = pendingPCM.prefix(chunkBytes)
            chunk.withUnsafeBytes { rawBuffer in
                guard let baseAddress = rawBuffer.baseAddress else {
                    return
                }
                writeAll(fd: STDOUT_FILENO, buffer: baseAddress, count: rawBuffer.count)
            }
            pendingPCM.removeFirst(chunkBytes)
        }
    }

    private func flushPendingPCM() {
        guard !pendingPCM.isEmpty else {
            return
        }

        pendingPCM.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else {
                return
            }
            writeAll(fd: STDOUT_FILENO, buffer: baseAddress, count: rawBuffer.count)
        }
        pendingPCM.removeAll(keepingCapacity: false)
    }

    private func getTapUID() throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var unmanagedUID: Unmanaged<CFString>?
        var dataSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &unmanagedUID) { pointer in
            AudioObjectGetPropertyData(tapID, &address, 0, nil, &dataSize, pointer)
        }
        guard status == noErr, let unmanagedUID else {
            throw makeError("Failed to get tap UID", status: status, operation: "get_tap_uid")
        }
        return unmanagedUID.takeRetainedValue() as String
    }
}

@available(macOS 14.2, *)
func parseConfig() -> Config {
    var sampleRate = 24_000.0
    var chunkMilliseconds = 100
    let args = Array(CommandLine.arguments.dropFirst())
    var index = 0

    while index < args.count {
        switch args[index] {
        case "--sample-rate":
            if index + 1 < args.count, let value = Double(args[index + 1]), value > 0 {
                sampleRate = value
            }
            index += 2
        case "--chunk-ms":
            if index + 1 < args.count, let value = Int(args[index + 1]), value > 0 {
                chunkMilliseconds = value
            }
            index += 2
        default:
            index += 1
        }
    }

    return Config(sampleRate: sampleRate, chunkMilliseconds: chunkMilliseconds)
}

func emit(event: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(event) else {
        return
    }

    guard let data = try? JSONSerialization.data(withJSONObject: event) else {
        return
    }

    FileHandle.standardError.write(data)
    FileHandle.standardError.write(Data([0x0a]))
}

func writeAll(fd: Int32, buffer: UnsafeRawPointer, count: Int) {
    var written = 0
    while written < count {
        let result = Darwin.write(fd, buffer.advanced(by: written), count - written)
        if result <= 0 {
            break
        }
        written += result
    }
}

func makeError(
    _ message: String,
    status: OSStatus? = nil,
    operation: String,
    code: String? = nil
) -> NSError {
    var userInfo: [String: Any] = [NSLocalizedDescriptionKey: message]
    let resolvedCode = code ?? inferErrorCode(status: status, operation: operation)
    userInfo["AudioTapErrorCode"] = resolvedCode
    userInfo["AudioTapOperation"] = operation
    if let status {
        userInfo["AudioTapStatus"] = Int(status)
        userInfo["NSLocalizedFailureReasonErrorKey"] = "\(message): \(Int(status))"
    }
    return NSError(domain: "OpenWhisprAudioTap", code: Int(status ?? -1), userInfo: userInfo)
}

func inferErrorCode(status: OSStatus?, operation: String) -> String {
    if status == kAudioHardwareIllegalOperationError {
        return "permission_denied"
    }
    return operation
}

if #available(macOS 14.2, *) {
    let capture = AudioTapCapture(config: parseConfig())
    var signalSources: [DispatchSourceSignal] = []

    func stopAndExit(_ code: Int32) -> Never {
        capture.stop()
        exit(code)
    }

    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)

    for signalValue in [SIGINT, SIGTERM] {
        let source = DispatchSource.makeSignalSource(signal: signalValue, queue: .main)
        source.setEventHandler {
            stopAndExit(0)
        }
        source.resume()
        signalSources.append(source)
    }

    do {
        try capture.start()
        dispatchMain()
    } catch {
        let nsError = error as NSError
        emit(event: [
            "type": "error",
            "code": nsError.userInfo["AudioTapErrorCode"] as? String ?? "start_failed",
            "message": nsError.localizedDescription,
            "operation": nsError.userInfo["AudioTapOperation"] as? String ?? "start",
            "status": nsError.userInfo["AudioTapStatus"] as? Int ?? nsError.code,
        ])
        capture.stop()
        exit(1)
    }
} else {
    emit(event: [
        "type": "error",
        "code": "unsupported_os",
        "message": "macOS 14.2 or later is required",
    ])
    exit(1)
}

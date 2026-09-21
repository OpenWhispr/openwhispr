import AVFoundation
import ExpoModulesCore
import Foundation

private enum AudioToolsError: LocalizedError {
  case invalidUri(String)
  case missingFile(String)
  case conversionFailed(String)

  var errorDescription: String? {
    switch self {
    case .invalidUri(let uri): return "Invalid audio uri: \(uri)"
    case .missingFile(let path): return "Audio file does not exist: \(path)"
    case .conversionFailed(let reason): return "Audio conversion failed: \(reason)"
    }
  }
}

// whisper.rn only decodes 16kHz mono 16-bit PCM WAV, and the cloud endpoint
// caps each request well below the size of a long recording, so uploads are
// normalized to 16kHz mono WAV here before transcription (one file for local,
// segment-sized files for cloud). WAV is used for both because the cloud's audio
// format detection only recognizes a fixed set of container magic bytes (RIFF
// among them, but not the box-size-prefixed MPEG-4 'ftyp').
private enum AudioTranscoder {
  static let targetSampleRate: Double = 16000
  private static let inputFrameCapacity: AVAudioFrameCount = 16384
  private static let wavSettings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: targetSampleRate,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
  ]

  static func fileUrl(from uri: String) -> URL? {
    if uri.hasPrefix("file://") {
      return URL(string: uri)
    }
    return URL(fileURLWithPath: uri)
  }

  static func transcodeToWav(inputUri: String) throws -> [String: Any] {
    let inputUrl = try resolveExistingFile(inputUri)
    let outputUrl = makeTempUrl(suffix: "transcode", fileExtension: "wav")

    // Accumulate 16-bit PCM and write a canonical WAV directly. AVAudioFile
    // emits a non-canonical WAV container that whisper.rn's parser rejects
    // ("Invalid WAV file"), even though the audio itself is valid.
    var pcm = Data()
    var totalFrames = 0
    try decodeToMonoFloat(inputUrl: inputUrl) { buffer in
      appendInt16Pcm(from: buffer, into: &pcm)
      totalFrames += Int(buffer.frameLength)
    }
    let wav = canonicalWavData(
      pcm: pcm,
      sampleRate: UInt32(targetSampleRate),
      channels: 1,
      bitsPerSample: 16
    )
    try wav.write(to: outputUrl, options: .atomic)

    let durationMs = Int(Double(totalFrames) / targetSampleRate * 1000)
    return ["uri": outputUrl.absoluteString, "durationMs": durationMs]
  }

  static func splitToChunks(inputUri: String, segmentSeconds: Int) throws -> [String: Any] {
    let inputUrl = try resolveExistingFile(inputUri)
    let segmentFrames = AVAudioFramePosition(Double(segmentSeconds) * targetSampleRate)

    let batchId = UUID().uuidString
    var chunkUris: [String] = []
    var currentFile: AVAudioFile?
    var framesInCurrent: AVAudioFramePosition = 0
    var totalFrames: AVAudioFramePosition = 0

    try decodeToMonoFloat(inputUrl: inputUrl) { buffer in
      if currentFile == nil || framesInCurrent >= segmentFrames {
        let chunkUrl = makeTempUrl(
          suffix: "\(batchId)_chunk-\(String(format: "%03d", chunkUris.count))",
          fileExtension: "wav"
        )
        currentFile = try AVAudioFile(forWriting: chunkUrl, settings: wavSettings)
        framesInCurrent = 0
        chunkUris.append(chunkUrl.absoluteString)
      }
      try currentFile?.write(from: buffer)
      framesInCurrent += AVAudioFramePosition(buffer.frameLength)
      totalFrames += AVAudioFramePosition(buffer.frameLength)
    }
    currentFile = nil  // finalize the last chunk before it is uploaded

    let durationMs = Int(Double(totalFrames) / targetSampleRate * 1000)
    return ["chunks": chunkUris, "durationMs": durationMs]
  }

  // Decodes any AVFoundation-readable file into 16kHz mono float32 buffers,
  // resampling and downmixing as needed. Shared by transcodeToWav and splitToChunks.
  private static func decodeToMonoFloat(
    inputUrl: URL,
    onOutput: (AVAudioPCMBuffer) throws -> Void
  ) throws {
    let inputFile = try AVAudioFile(forReading: inputUrl)
    let inputFormat = inputFile.processingFormat

    guard
      let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: targetSampleRate,
        channels: 1,
        interleaved: false
      )
    else {
      throw AudioToolsError.conversionFailed("could not create 16kHz mono format")
    }
    guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
      throw AudioToolsError.conversionFailed("unsupported source format")
    }

    let resampleRatio = outputFormat.sampleRate / inputFormat.sampleRate
    let outputCapacity = AVAudioFrameCount(Double(inputFrameCapacity) * resampleRatio) + 1024
    var inputExhausted = false

    while !inputExhausted {
      guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outputCapacity) else {
        throw AudioToolsError.conversionFailed("could not allocate output buffer")
      }

      var conversionError: NSError?
      let status = converter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
        guard
          let inputBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: inputFrameCapacity),
          (try? inputFile.read(into: inputBuffer)) != nil,
          inputBuffer.frameLength > 0
        else {
          inputStatus.pointee = .endOfStream
          return nil
        }
        inputStatus.pointee = .haveData
        return inputBuffer
      }

      if let conversionError {
        throw conversionError
      }
      if outputBuffer.frameLength > 0 {
        try onOutput(outputBuffer)
      }
      if status == .endOfStream || status == .error {
        inputExhausted = true
      }
    }
  }

  private static func resolveExistingFile(_ uri: String) throws -> URL {
    guard let url = fileUrl(from: uri) else {
      throw AudioToolsError.invalidUri(uri)
    }
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw AudioToolsError.missingFile(url.path)
    }
    return url
  }

  private static func makeTempUrl(suffix: String, fileExtension: String) -> URL {
    let name = "audiotools_\(suffix).\(fileExtension)"
    return URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name)
  }

  private static func appendInt16Pcm(from buffer: AVAudioPCMBuffer, into data: inout Data) {
    guard let channel = buffer.floatChannelData?[0] else { return }
    let frames = Int(buffer.frameLength)
    data.reserveCapacity(data.count + frames * 2)
    for index in 0..<frames {
      let clamped = max(-1.0, min(1.0, channel[index]))
      var sample = Int16(clamped * 32767.0).littleEndian
      withUnsafeBytes(of: &sample) { data.append(contentsOf: $0) }
    }
  }

  private static func canonicalWavData(
    pcm: Data,
    sampleRate: UInt32,
    channels: UInt16,
    bitsPerSample: UInt16
  ) -> Data {
    var data = Data()
    func appendLE32(_ value: UInt32) {
      var le = value.littleEndian
      withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }
    func appendLE16(_ value: UInt16) {
      var le = value.littleEndian
      withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }

    let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
    let blockAlign = channels * (bitsPerSample / 8)
    let dataSize = UInt32(pcm.count)

    data.append(Data("RIFF".utf8))
    appendLE32(36 + dataSize)
    data.append(Data("WAVE".utf8))
    data.append(Data("fmt ".utf8))
    appendLE32(16)
    appendLE16(1) // PCM
    appendLE16(channels)
    appendLE32(sampleRate)
    appendLE32(byteRate)
    appendLE16(blockAlign)
    appendLE16(bitsPerSample)
    data.append(Data("data".utf8))
    appendLE32(dataSize)
    data.append(pcm)
    return data
  }
}

// Splits an Ogg-Opus file (which AVFoundation cannot decode) into smaller, still
// valid standalone Ogg-Opus files by re-paginating at the container level, with
// no audio decoding. Each chunk replays the OpusHead/OpusTags header pages and
// carries a run of audio pages, renumbered with recomputed CRCs, so the cloud
// transcriber can decode each one independently.
private enum OggSplitter {
  private struct Page {
    let bytes: [UInt8]
    let headerType: UInt8
    let granule: UInt64
  }

  // Ogg CRC-32: poly 0x04c11db7, no input/output reflection, zero init/xor.
  private static let crcTable: [UInt32] = {
    var table = [UInt32](repeating: 0, count: 256)
    for index in 0..<256 {
      var remainder = UInt32(index) << 24
      for _ in 0..<8 {
        remainder = (remainder & 0x8000_0000) != 0 ? (remainder << 1) ^ 0x04c1_1db7 : (remainder << 1)
      }
      table[index] = remainder
    }
    return table
  }()

  private static func crc32(_ bytes: [UInt8]) -> UInt32 {
    var crc: UInt32 = 0
    for byte in bytes {
      crc = (crc << 8) ^ crcTable[Int(((crc >> 24) & 0xff) ^ UInt32(byte))]
    }
    return crc
  }

  static func split(inputUri: String, maxBytes: Int) throws -> [String: Any] {
    guard let inputUrl = AudioTranscoder.fileUrl(from: inputUri) else {
      throw AudioToolsError.invalidUri(inputUri)
    }
    guard FileManager.default.fileExists(atPath: inputUrl.path) else {
      throw AudioToolsError.missingFile(inputUrl.path)
    }

    let bytes = [UInt8](try Data(contentsOf: inputUrl))
    let pages = try parsePages(bytes)

    // Leading pages with granule position 0 are the codec headers (OpusHead,
    // OpusTags); audio pages follow with a non-zero granule position.
    var headerCount = 0
    for page in pages {
      if page.granule == 0 {
        headerCount += 1
      } else {
        break
      }
    }
    guard headerCount > 0, headerCount < pages.count else {
      throw AudioToolsError.conversionFailed("not a splittable Ogg stream")
    }

    let headerPages = Array(pages[0..<headerCount])
    let audioPages = Array(pages[headerCount...])
    let headerSize = headerPages.reduce(0) { $0 + $1.bytes.count }

    var groups: [[Page]] = []
    var current: [Page] = []
    var currentSize = headerSize
    for page in audioPages {
      let startsFreshPacket = (page.headerType & 0x01) == 0
      if !current.isEmpty && startsFreshPacket && currentSize + page.bytes.count > maxBytes {
        groups.append(current)
        current = []
        currentSize = headerSize
      }
      current.append(page)
      currentSize += page.bytes.count
    }
    if !current.isEmpty {
      groups.append(current)
    }

    let batchId = UUID().uuidString
    var chunkUris: [String] = []
    for (groupIndex, group) in groups.enumerated() {
      let allPages = headerPages + group
      var out: [UInt8] = []
      for (pageIndex, page) in allPages.enumerated() {
        out.append(
          contentsOf: reserialize(
            page: page.bytes,
            sequence: UInt32(pageIndex),
            isFirst: pageIndex == 0,
            isLast: pageIndex == allPages.count - 1
          )
        )
      }
      let chunkUrl = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("audiotools_\(batchId)_opus-\(String(format: "%03d", groupIndex)).ogg")
      try Data(out).write(to: chunkUrl)
      chunkUris.append(chunkUrl.absoluteString)
    }

    let lastGranule = audioPages.last(where: { $0.granule != UInt64.max })?.granule ?? 0
    let durationMs = Int(Double(lastGranule) / 48000.0 * 1000)
    return ["chunks": chunkUris, "durationMs": durationMs]
  }

  private static func parsePages(_ bytes: [UInt8]) throws -> [Page] {
    var pages: [Page] = []
    var offset = 0
    while offset + 27 <= bytes.count {
      guard
        bytes[offset] == 0x4F, bytes[offset + 1] == 0x67,
        bytes[offset + 2] == 0x67, bytes[offset + 3] == 0x53
      else {
        throw AudioToolsError.conversionFailed("invalid Ogg page header")
      }
      let segmentCount = Int(bytes[offset + 26])
      let segmentTableStart = offset + 27
      guard segmentTableStart + segmentCount <= bytes.count else {
        throw AudioToolsError.conversionFailed("truncated Ogg segment table")
      }
      var bodyLength = 0
      for i in 0..<segmentCount {
        bodyLength += Int(bytes[segmentTableStart + i])
      }
      let pageLength = 27 + segmentCount + bodyLength
      guard offset + pageLength <= bytes.count else {
        throw AudioToolsError.conversionFailed("truncated Ogg page")
      }
      pages.append(
        Page(
          bytes: Array(bytes[offset..<(offset + pageLength)]),
          headerType: bytes[offset + 5],
          granule: readUInt64LE(bytes, offset + 6)
        )
      )
      offset += pageLength
    }
    return pages
  }

  private static func reserialize(
    page bytes: [UInt8],
    sequence: UInt32,
    isFirst: Bool,
    isLast: Bool
  ) -> [UInt8] {
    var out = bytes
    var headerType = out[5] & 0x01  // preserve the "continued packet" bit
    if isFirst { headerType |= 0x02 }  // beginning of stream
    if isLast { headerType |= 0x04 }  // end of stream
    out[5] = headerType
    out[18] = UInt8(sequence & 0xff)
    out[19] = UInt8((sequence >> 8) & 0xff)
    out[20] = UInt8((sequence >> 16) & 0xff)
    out[21] = UInt8((sequence >> 24) & 0xff)
    out[22] = 0
    out[23] = 0
    out[24] = 0
    out[25] = 0
    let crc = crc32(out)
    out[22] = UInt8(crc & 0xff)
    out[23] = UInt8((crc >> 8) & 0xff)
    out[24] = UInt8((crc >> 16) & 0xff)
    out[25] = UInt8((crc >> 24) & 0xff)
    return out
  }

  private static func readUInt64LE(_ bytes: [UInt8], _ offset: Int) -> UInt64 {
    var value: UInt64 = 0
    for i in 0..<8 {
      value |= UInt64(bytes[offset + i]) << (8 * i)
    }
    return value
  }
}

public class AudioToolsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AudioTools")

    AsyncFunction("transcodeToWav") { (inputUri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try AudioTranscoder.transcodeToWav(inputUri: inputUri))
        } catch {
          promise.reject("AUDIO_TRANSCODE_ERROR", error.localizedDescription)
        }
      }
    }

    AsyncFunction("splitOggOpus") { (inputUri: String, maxBytes: Int, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try OggSplitter.split(inputUri: inputUri, maxBytes: maxBytes))
        } catch {
          promise.reject("AUDIO_CHUNK_ERROR", error.localizedDescription)
        }
      }
    }

    AsyncFunction("splitToChunks") { (inputUri: String, segmentSeconds: Int, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(
            try AudioTranscoder.splitToChunks(inputUri: inputUri, segmentSeconds: segmentSeconds)
          )
        } catch {
          promise.reject("AUDIO_CHUNK_ERROR", error.localizedDescription)
        }
      }
    }

    AsyncFunction("cleanup") { (uris: [String]) in
      for uri in uris {
        if let url = AudioTranscoder.fileUrl(from: uri) {
          try? FileManager.default.removeItem(at: url)
        }
      }
    }
  }
}

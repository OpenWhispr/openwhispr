import AVFoundation
import Foundation

enum DirectAudioEncoder {
  private static let blockSamples = 16_000

  /// Reads the PCM file in blocks, multiplies by `gain` with clamping to Int16, and writes
  /// AAC (16 kHz, mono, 32 kbps — what the app uploads today) to `m4aURL`, replacing any file
  /// there. Never loads the whole take into memory.
  static func encodeAAC(pcmURL: URL, m4aURL: URL, gain: Float) throws {
    // Open the input first, so a missing take never destroys an earlier encoding.
    let input = try FileHandle(forReadingFrom: pcmURL)
    defer { try? input.close() }
    // Written aside and moved into place, so a keyboard killed mid-encode never leaves a cut-off
    // .m4a that would be uploaded as the take; its .pcm is encoded again instead.
    let partial = m4aURL.appendingPathExtension("partial")
    try? FileManager.default.removeItem(at: partial)
    try write(from: input, to: partial, gain: gain)
    try? FileManager.default.removeItem(at: m4aURL)
    try FileManager.default.moveItem(at: partial, to: m4aURL)
  }

  // A separate function so the AVAudioFile is released, and the file finalized, on return.
  private static func write(from input: FileHandle, to url: URL, gain: Float) throws {
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: Double(PcmFileWriter.sampleRate),
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: 32_000,
    ]
    let file = try AVAudioFile(
      forWriting: url, settings: settings, commonFormat: .pcmFormatInt16, interleaved: true
    )
    guard
      let buffer = AVAudioPCMBuffer(
        pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(blockSamples)
      ),
      let channel = buffer.int16ChannelData?[0]
    else {
      throw NSError(domain: "DirectAudioEncoder", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "Unable to allocate the encoding buffer"
      ])
    }

    while let block = try input.read(upToCount: blockSamples * 2), !block.isEmpty {
      let frames = block.count / 2
      guard frames > 0 else { break }
      block.withUnsafeBytes { raw in
        let samples = raw.bindMemory(to: Int16.self)
        for index in 0..<frames {
          let boosted = Float(Int16(littleEndian: samples[index])) * gain
          channel[index] = Int16(max(-32_768, min(32_767, boosted.rounded())))
        }
      }
      buffer.frameLength = AVAudioFrameCount(frames)
      try file.write(from: buffer)
    }
  }
}

import Foundation

// Canonical 44-byte RIFF/WAVE header for little-endian integer PCM. Kept
// Foundation-only so it can be unit-tested without AVFoundation.
public enum WavHeader {
  public static let byteCount = 44

  /// A canonical PCM header for `dataBytes` of audio.
  public static func make(sampleRate: Int, channels: Int, bitsPerSample: Int, dataBytes: UInt32) -> Data {
    let blockAlign = channels * bitsPerSample / 8
    let byteRate = sampleRate * blockAlign
    var header = Data(capacity: byteCount)
    header.append(contentsOf: Array("RIFF".utf8))
    appendLE32(&header, UInt32(36) &+ dataBytes)
    header.append(contentsOf: Array("WAVE".utf8))
    header.append(contentsOf: Array("fmt ".utf8))
    appendLE32(&header, 16)
    appendLE16(&header, 1)
    appendLE16(&header, UInt16(channels))
    appendLE32(&header, UInt32(sampleRate))
    appendLE32(&header, UInt32(byteRate))
    appendLE16(&header, UInt16(blockAlign))
    appendLE16(&header, UInt16(bitsPerSample))
    header.append(contentsOf: Array("data".utf8))
    appendLE32(&header, dataBytes)
    return header
  }

  /// Audio bytes in a file of this size, rounded down to whole sample frames; 0 for a file shorter than the header.
  public static func dataBytes(forFileSize size: UInt64, channels: Int, bitsPerSample: Int) -> UInt32 {
    guard size > UInt64(byteCount) else { return 0 }
    let blockAlign = UInt64(max(1, channels * bitsPerSample / 8))
    let audio = size - UInt64(byteCount)
    // The RIFF size field holds this plus 36, so leave room for that in 32 bits.
    let limit = UInt64(UInt32.max - 36) / blockAlign * blockAlign
    return UInt32(min(audio / blockAlign * blockAlign, limit))
  }

  private static func appendLE16(_ data: inout Data, _ value: UInt16) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
  }

  private static func appendLE32(_ data: inout Data, _ value: UInt32) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
  }
}

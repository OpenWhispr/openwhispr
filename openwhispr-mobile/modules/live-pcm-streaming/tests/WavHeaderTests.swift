import Foundation

@main
struct WavHeaderTests {
  static func main() {
    headerDescribesMono16kPcm()
    dataBytesFromFileSize()
    print("WavHeaderTests: all passed")
  }

  static func expect(_ condition: Bool, _ message: String) {
    precondition(condition, message)
  }

  static func le16(_ data: Data, _ offset: Int) -> Int {
    let bytes = [UInt8](data)
    return Int(bytes[offset]) | Int(bytes[offset + 1]) << 8
  }

  static func le32(_ data: Data, _ offset: Int) -> Int {
    let bytes = [UInt8](data)
    return Int(bytes[offset]) | Int(bytes[offset + 1]) << 8
      | Int(bytes[offset + 2]) << 16 | Int(bytes[offset + 3]) << 24
  }

  static func headerDescribesMono16kPcm() {
    let h = WavHeader.make(sampleRate: 16_000, channels: 1, bitsPerSample: 16, dataBytes: 32_000)
    expect(h.count == 44, "44 bytes")
    expect(String(bytes: h[0..<4], encoding: .ascii) == "RIFF", "RIFF tag")
    expect(le32(h, 4) == 36 + 32_000, "RIFF size")
    expect(String(bytes: h[8..<16], encoding: .ascii) == "WAVEfmt ", "WAVE fmt")
    expect(le16(h, 20) == 1 && le16(h, 22) == 1, "PCM, mono")
    expect(le32(h, 24) == 16_000 && le32(h, 28) == 32_000, "rate, byte rate")
    expect(le16(h, 32) == 2 && le16(h, 34) == 16, "block align, bits")
    expect(String(bytes: h[36..<40], encoding: .ascii) == "data" && le32(h, 40) == 32_000, "data chunk")
  }

  static func dataBytesFromFileSize() {
    expect(WavHeader.dataBytes(forFileSize: 44 + 32_001, channels: 1, bitsPerSample: 16) == 32_000, "odd tail byte dropped")
    expect(WavHeader.dataBytes(forFileSize: 20, channels: 1, bitsPerSample: 16) == 0, "shorter than a header")
  }
}

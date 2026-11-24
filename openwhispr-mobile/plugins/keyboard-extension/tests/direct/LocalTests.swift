import Foundation

extension DirectDictationTests {
  static func testLocal() {
    testWavHeader()
    testBudget()
  }

  static func testWavHeader() {
    let folder = tempFolder("wav")
    defer { try? FileManager.default.removeItem(at: folder) }
    let pcm = folder.appendingPathComponent("take.pcm")
    let wav = folder.appendingPathComponent("take.wav")
    let samples = Data((0..<32_000).map { UInt8(truncatingIfNeeded: $0) })
    try! samples.write(to: pcm)
    try! Data("stale".utf8).write(to: wav)  // a leftover is replaced, not appended to
    try! PcmWav.wrap(pcmURL: pcm, into: wav)
    let data = (try? Data(contentsOf: wav)) ?? Data()

    func uint32(at offset: Int) -> UInt32 {
      data.subdata(in: offset..<offset + 4).withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
    }
    func uint16(at offset: Int) -> UInt16 {
      data.subdata(in: offset..<offset + 2).withUnsafeBytes { UInt16(littleEndian: $0.loadUnaligned(as: UInt16.self)) }
    }
    func text(at offset: Int) -> String { String(decoding: data.subdata(in: offset..<offset + 4), as: UTF8.self) }

    expect(data.count, 32_044, "wav: 44-byte header + the PCM")
    guard data.count == 32_044 else { return }
    expect(text(at: 0), "RIFF", "wav: RIFF")
    expect(uint32(at: 4), 32_036, "wav: RIFF size")
    expect(text(at: 8), "WAVE", "wav: WAVE")
    expect(text(at: 12), "fmt ", "wav: fmt chunk")
    expect(uint16(at: 20), 1, "wav: PCM format")
    expect(uint16(at: 22), 1, "wav: mono")
    expect(uint32(at: 24), 16_000, "wav: 16 kHz")
    expect(uint32(at: 28), 32_000, "wav: byte rate")
    expect(uint16(at: 34), 16, "wav: 16-bit")
    expect(text(at: 36), "data", "wav: data chunk")
    expect(uint32(at: 40), 32_000, "wav: data size")
    expect(data.subdata(in: 44..<data.count), samples, "wav: the PCM follows unchanged")
  }

  static func testBudget() {
    let mb = 1024 * 1024
    typealias B = KeyboardParakeetBudget
    // An iPhone 16 Pro keyboard: 177 MB limit.
    expect(B.allowsLoad(footprint: 27 * mb, available: 150 * mb), true, "budget: 177 MB limit, 150 available loads")
    expect(B.allowsLoad(footprint: 20 * mb, available: 80 * mb), false, "budget: 100 MB limit refuses")
    expect(B.allowsLoad(footprint: 127 * mb, available: 50 * mb), false, "budget: 50 MB available refuses a load")
    expect(B.allowsTranscription(footprint: 127 * mb, available: 50 * mb), true, "budget: 50 MB available transcribes")
    expect(B.allowsTranscription(footprint: 150 * mb, available: 27 * mb), false, "budget: 27 MB available refuses a transcription")
    expect(B.allowsLoad(footprint: 30 * mb, available: 0), true, "budget: no limit reported loads")
    expect(B.allowsTranscription(footprint: 30 * mb, available: 0), true, "budget: no limit reported transcribes")
    expect(B.allowsLoad(footprint: 56 * mb, available: 64 * mb), true, "budget: exactly 120 MB and 64 MB loads")
  }
}

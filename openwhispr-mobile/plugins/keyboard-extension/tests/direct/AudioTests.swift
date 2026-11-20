import AVFoundation

extension DirectDictationTests {
  static func pcm(seconds: Double, amplitude: Double, hz: Double = 220) -> Data {
    let count = Int(seconds * 16_000)
    var data = Data(capacity: count * 2)
    for index in 0..<count {
      let sample = Int16(amplitude * 32_767 * sin(2 * .pi * hz * Double(index) / 16_000))
      withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) }
    }
    return data
  }

  /// RMS (0...1) of an audio file decoded to float.
  static func decodedRms(_ url: URL) -> (frames: Int, rate: Double, rms: Double) {
    let file = try! AVAudioFile(forReading: url)
    let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
    try! file.read(into: buffer)
    let samples = UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
    let energy = samples.reduce(0.0) { $0 + Double($1) * Double($1) }
    return (Int(buffer.frameLength), file.fileFormat.sampleRate, (energy / Double(max(samples.count, 1))).squareRoot())
  }

  static func testAudio() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("direct-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let pcmURL = folder.appendingPathComponent("take.pcm")
    let m4aURL = folder.appendingPathComponent("take.m4a")

    let writer = try! PcmFileWriter(url: pcmURL)
    try! writer.append(Data([0x10, 0x00, 0x00, 0x80]))      // 16 and -32768
    try! writer.append(pcm(seconds: 1, amplitude: 0.05))
    writer.close()
    expect(writer.sampleCount, 16_002, "sampleCount")
    expect(writer.peakSample, 32_768, "peak is the largest absolute value")
    expect(writer.durationMs, 1000, "durationMs")
    expect((try! Data(contentsOf: pcmURL)).count, 32_004, "bytes on disk")

    expect(DirectGain.factor(peakSample: 0), 1, "silence: no gain")
    expect(DirectGain.factor(peakSample: 32_767), 1, "never attenuates")
    expect(abs(DirectGain.factor(peakSample: 2_294) - 10) < 0.01, true, "0.07 of full scale → ×10")
    expect(DirectGain.factor(peakSample: 100), 31.6, "capped at 30 dB")

    // A quiet 1 s tone boosted ×10 and encoded.
    let quiet = try! PcmFileWriter(url: pcmURL)
    try! quiet.append(pcm(seconds: 1, amplitude: 0.05))
    quiet.close()
    try! DirectAudioEncoder.encodeAAC(pcmURL: pcmURL, m4aURL: m4aURL, gain: 10)
    let boosted = decodedRms(m4aURL)
    expect(boosted.rate, 16_000, "AAC sample rate")
    expect(abs(boosted.frames - 16_000) < 3_000, true, "about one second of frames")
    expect(abs(boosted.rms - 0.5 / 2.0.squareRoot()) < 0.06, true, "0.05 × 10 = 0.5 amplitude")
    let size = (try! FileManager.default.attributesOfItem(atPath: m4aURL.path)[.size] as! NSNumber).intValue
    expect(size > 0 && size < 32_000, true, "smaller than the PCM")

    // Clamps instead of wrapping around.
    try! DirectAudioEncoder.encodeAAC(pcmURL: pcmURL, m4aURL: m4aURL, gain: 100)
    expect(decodedRms(m4aURL).rms > 0.8, true, "clipped square-ish wave, not wrapped noise")

    // Replaces an existing file; fails cleanly on a missing input.
    try! DirectAudioEncoder.encodeAAC(pcmURL: pcmURL, m4aURL: m4aURL, gain: 1)
    expect(abs(decodedRms(m4aURL).rms - 0.05 / 2.0.squareRoot()) < 0.01, true, "unity gain")
    var threw = false
    do { try DirectAudioEncoder.encodeAAC(pcmURL: folder.appendingPathComponent("missing.pcm"), m4aURL: m4aURL, gain: 1) } catch { threw = true }
    expect(threw, true, "missing input throws")

    var silent = SpeechActivityMeter()
    silent.add(pcm(seconds: 1, amplitude: 0))
    expect(silent.result().reason, "nearly_silent", "silence")
    expect(silent.result().noSpeechLikely, true, "silence is no speech")

    var short = SpeechActivityMeter()
    short.add(pcm(seconds: 0.1, amplitude: 0.3))
    expect(short.result().reason, "too_short", "under 250 ms")

    // The level mode D produced on the phone: peak RMS about 0.02.
    var quietSpeech = SpeechActivityMeter()
    quietSpeech.add(pcm(seconds: 0.5, amplitude: 0))
    for _ in 0..<10 { quietSpeech.add(pcm(seconds: 0.1, amplitude: 0.03)) }   // fed in chunks
    expect(quietSpeech.result().reason, "speech_activity_detected", "quiet tone over silence")
    expect(quietSpeech.result().noSpeechLikely, false, "quiet speech is speech")
    expect(quietSpeech.result().durationMs, 1500, "duration")

    expect(SpeechActivityMeter().result().reason, "analysis_empty", "no audio")
    expect(directMeterLevel(rms: 1), 1, "0 dB clamps to 1")
    expect(directMeterLevel(rms: 0), 0, "silence clamps to 0")
    expect(abs(directMeterLevel(rms: 0.1) - 0.6) < 0.001, true, "-20 dB maps to 0.6")
  }
}

import FluidAudio

/// Pay the first Core ML prediction cost while the model-preparation UI is open.
/// The 300 ms silence and its decoder state never become part of a recording.
enum OrukeetWarmup {
  static func run(on manager: AsrManager) async throws {
    try Task.checkCancellation()
    var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
    _ = try await manager.transcribe(
      [Float](repeating: 0, count: 4_800), decoderState: &state, language: nil)
    try Task.checkCancellation()
  }
}

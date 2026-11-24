// FluidAudio is linked into the keyboard target only; the Mac Catalyst touch tests compile every
// keyboard source without it.
#if canImport(FluidAudio)
import CoreML
import Darwin
import FluidAudio
import Foundation

/// Parakeet on the Neural Engine inside the keyboard's own process, reading the model the app
/// downloaded into the App Group. The approach follows Hex (github.com/anomalyco/hex, MIT).
///
/// Never touches the network or the model files: it loads each Core ML bundle with
/// `MLModel(contentsOf:configuration:)` and hands them to `AsrManager.loadModels(_:)`, which
/// only stores them. FluidAudio's own loaders (`AsrModels.load`, `downloadAndLoad`, via
/// `DownloadUtils.loadModels`) download a missing model and delete and re-download a folder
/// they fail to load, so none of them is called here.
///
/// The take's audio and text stay on the device, and the text is never logged.
@available(iOS 26.0, *)
@MainActor
final class KeyboardParakeetTranscriber: @preconcurrency DirectLocalTranscriber {
  nonisolated private static let megabyte = 1024 * 1024
  /// The neural ledger rose ~468 MB for v2 in the spike; a model left on the CPU raises it by
  /// nothing.
  private static let neuralRiseThreshold = 100 * megabyte
  /// Below iOS 27 the ledger doesn't count the Neural Engine's memory, so Core ML's plan for
  /// the encoder decides instead.
  private static let neuralShareThreshold = 0.5
  /// A load that failed (files mid-replace, a damaged model) is tried again after this, not
  /// on the very next eligibility read: each attempt costs seconds and tens of MB.
  private static let retryAfterFailure: TimeInterval = 60

  private(set) var readyModel: DirectLocalModel?
  /// One line per load and per transcription: timings and MB only.
  var log: ((String) -> Void)?

  private let speechModels: URL?
  private var manager: AsrManager?
  private var loading: DirectLocalModel?
  /// Bumped by every release, so a load that finishes after one is dropped.
  private var generation = 0
  /// Models that loaded off the Neural Engine: not retried in this process.
  private var offNeuralEngine: Set<DirectLocalModel> = []
  private var residency = ParakeetResidency()
  private var lastRefusal: String?
  private var lastFailure: (model: DirectLocalModel, at: TimeInterval)?

  /// `appGroupContainer` is nil without an App Group, and then nothing ever loads.
  init(appGroupContainer: URL?) {
    speechModels = appGroupContainer?.appendingPathComponent(
      "Library/Application Support/SpeechModels", isDirectory: true
    )
  }

  // MARK: - DirectLocalTranscriber

  /// Called on every eligibility read while the model isn't ready, so it does nothing while a
  /// load is under way, and a refusal costs a few `fileExists` and one memory read.
  func prepare(_ model: DirectLocalModel) {
    guard readyModel != model, loading == nil else { return }
    // A running transcription holds the loaded model; swapping it now could leave the take
    // without one. The next eligibility read asks again.
    guard !residency.isTranscribing else { return }
    guard let directory = speechModels?.appendingPathComponent(model.folderName, isDirectory: true) else {
      return refuse(model, "no App Group")
    }
    guard !offNeuralEngine.contains(model) else { return refuse(model, "not on the Neural Engine") }
    guard Self.hasNeuralEngine else { return refuse(model, "no Neural Engine") }
    guard Self.modelFilesPresent(in: directory, model: model) else { return refuse(model, "model not on the device") }
    guard residency.mayLoad(now: Self.uptime) else { return refuse(model, "cooling down after a memory warning") }
    if let lastFailure, lastFailure.model == model, Self.uptime - lastFailure.at < Self.retryAfterFailure {
      return refuse(model, "waiting to retry a failed load")
    }
    let before = Self.memory()
    guard KeyboardParakeetBudget.allowsLoad(footprint: before.footprint, available: before.available) else {
      return refuse(model, String(format: "no room (limit %.0f MB, available %.0f MB)",
                                  Self.mb(before.footprint + before.available), Self.mb(before.available)))
    }

    lastRefusal = nil
    releaseModel()
    loading = model
    let loadGeneration = generation
    let started = Self.uptime
    Task { [weak self] in
      let outcome: Result<(AsrManager, onNeuralEngine: Bool, detail: String), Error>
      do {
        let models = try await Task.detached(priority: .utility) {
          try Self.loadModels(from: directory, model: model)
        }.value
        let asr = AsrManager(config: ASRConfig(parallelChunkConcurrency: 1))
        try await asr.loadModels(models)
        let rise = Self.memory().neural - before.neural
        if rise >= Self.neuralRiseThreshold {
          outcome = .success((asr, true, String(format: "neural +%.0f MB", Self.mb(rise))))
        } else {
          let share = await Task.detached(priority: .utility) { await Self.encoderNeuralShare(in: directory) }.value
          // A plan that can't be read says nothing about where the model runs: treat it as a
          // failed load (retried later), never as proof that the model is off the Neural Engine.
          guard let share else {
            await asr.cleanup()
            throw TranscriberError.computePlanUnreadable
          }
          outcome = .success((asr, share >= Self.neuralShareThreshold,
                              String(format: "neural +%.0f MB, encoder plan %.0f%% Neural Engine", Self.mb(rise), share * 100)))
        }
      } catch {
        outcome = .failure(error)
      }
      self?.loadFinished(model, generation: loadGeneration, started: started, outcome: outcome)
    }
  }

  func transcribe(
    wavURL: URL, languageHint: String?, completion: @escaping (Result<String, Error>) -> Void
  ) -> DirectCancellable {
    let memory = Self.memory()
    guard let manager, let model = readyModel else {
      return Self.failLater(.notReady, completion)
    }
    guard KeyboardParakeetBudget.allowsTranscription(footprint: memory.footprint, available: memory.available) else {
      log?(String(format: "transcription refused: available %.0f MB", Self.mb(memory.available)))
      return Self.failLater(.noRoom, completion)
    }
    // v2 is English only and takes no hint; v3 uses it to keep tokens in the language's script.
    let language = model == .parakeetV3 ? languageHint.flatMap { Language(rawValue: $0) } : nil
    residency.transcriptionStarted()
    let started = Self.uptime
    let task = Task { [weak self] in
      let result: Result<String, Error>
      do {
        var decoderState = TdtDecoderState.make()
        let asr = try await manager.transcribe(wavURL, decoderState: &decoderState, language: language)
        let text = asr.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // The meter already caught silence, so no words is a failure, not an empty insert.
        result = text.isEmpty ? .failure(TranscriberError.emptyText) : .success(text)
      } catch {
        result = .failure(error)
      }
      self?.transcriptionFinished(started: started, footprintBefore: memory.footprint, result: result)
      completion(result)
    }
    return TaskCancellable(task: task)
  }

  // MARK: - Memory

  /// A memory warning: the model goes now, or when the running transcription ends. A take
  /// being recorded loses it too, and then fails at stop with Try again, which keeps its audio.
  func releaseWhenIdle() {
    guard residency.memoryWarning(now: Self.uptime) else {
      log?("memory warning: release after the running transcription")
      return
    }
    log?("memory warning: released")
    releaseModel()
  }

  /// Bytes: the process footprint, what's left before the keyboard's limit (0 on the
  /// simulator), and the Neural Engine memory charged outside the footprint.
  nonisolated static func memory() -> (footprint: Int, available: Int, neural: Int) {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let status = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    let available = os_proc_available_memory()
    guard status == KERN_SUCCESS else { return (0, available, 0) }
    return (
      Int(info.phys_footprint),
      available,
      Int(info.ledger_tag_neural_nofootprint + info.ledger_tag_neural_nofootprint_compressed)
    )
  }

  // MARK: - Private

  private enum TranscriberError: Error {
    case notReady
    case noRoom
    case emptyText
    case computePlanUnreadable
  }

  private func loadFinished(
    _ model: DirectLocalModel,
    generation loadGeneration: Int,
    started: TimeInterval,
    outcome: Result<(AsrManager, onNeuralEngine: Bool, detail: String), Error>
  ) {
    let seconds = Self.uptime - started
    let memory = Self.memory()
    let footprint = Self.mb(memory.footprint)
    guard loadGeneration == generation else {
      // Released while loading (a memory warning): dropping the result frees it.
      log?(String(format: "load %@ dropped after release (%.1f s)", model.rawValue, seconds))
      if case let .success((asr, _, _)) = outcome { Task { await asr.cleanup() } }
      return
    }
    loading = nil
    switch outcome {
    case let .success((asr, onNeuralEngine, detail)):
      guard onNeuralEngine else {
        offNeuralEngine.insert(model)
        Task { await asr.cleanup() }
        log?(String(format: "load %@ off the Neural Engine, released (%.1f s, %@)", model.rawValue, seconds, detail))
        return
      }
      manager = asr
      readyModel = model
      lastFailure = nil
      log?(String(format: "load %@ ready in %.1f s; footprint %.1f MB; %@", model.rawValue, seconds, footprint, detail))
    case let .failure(error):
      lastFailure = (model, Self.uptime)
      log?(String(format: "load %@ failed in %.1f s: %@", model.rawValue, seconds, String(describing: type(of: error))))
    }
  }

  private func transcriptionFinished(started: TimeInterval, footprintBefore: Int, result: Result<String, Error>) {
    let outcome: String
    switch result {
    case .success: outcome = "ok"
    case let .failure(error): outcome = "failed (\(type(of: error)))"
    }
    log?(String(format: "transcription %@ in %.2f s; footprint %.1f → %.1f MB",
                outcome, Self.uptime - started, Self.mb(footprintBefore), Self.mb(Self.memory().footprint)))
    if residency.transcriptionEnded() {
      log?("released after the transcription")
      releaseModel()
    }
  }

  /// Only called while no transcription runs (`ParakeetResidency` sees to it).
  private func releaseModel() {
    generation += 1
    loading = nil
    readyModel = nil
    if let old = manager {
      manager = nil
      Task { await old.cleanup() }
    }
  }

  private func refuse(_ model: DirectLocalModel, _ reason: String) {
    // prepare runs on every eligibility read: log a reason once, not on every read.
    let line = "load \(model.rawValue) refused: \(reason)"
    guard line != lastRefusal else { return }
    lastRefusal = line
    log?(line)
  }

  private static func failLater(
    _ error: TranscriberError, _ completion: @escaping (Result<String, Error>) -> Void
  ) -> DirectCancellable {
    // Never call back before the caller has stored the returned cancellable.
    DispatchQueue.main.async { completion(.failure(error)) }
    return TaskCancellable(task: nil)
  }

  private static let hasNeuralEngine = MLModel.availableComputeDevices.contains {
    if case .neuralEngine = $0 { return true }
    return false
  }

  nonisolated private static func fileNames(for model: DirectLocalModel) -> (encoder: String, joint: String, version: AsrModelVersion) {
    switch model {
    case .parakeetV2: return (ModelNames.ASR.encoderFile, ModelNames.ASR.jointFile, .v2)
    // The app downloads v3's int8 encoder (ParakeetASRModule's encoderPrecision).
    case .parakeetV3: return (ParakeetEncoderPrecision.int8.encoderFileName, ModelNames.ASR.jointV3File, .v3)
    }
  }

  /// FluidAudio's own check (read-only: `fileExists` only), with the int8 encoder the app
  /// downloads. The app swaps a model in by deleting the folder and renaming a complete staging
  /// folder into place, so files that are present are never half-written.
  private static func modelFilesPresent(in directory: URL, model: DirectLocalModel) -> Bool {
    AsrModels.modelsExist(at: directory, version: fileNames(for: model).version, encoderPrecision: .int8)
  }

  nonisolated private static func loadModels(from directory: URL, model: DirectLocalModel) throws -> AsrModels {
    let names = fileNames(for: model)
    func load(_ name: String, _ units: MLComputeUnits) throws -> MLModel {
      let configuration = AsrModels.defaultConfiguration()
      configuration.computeUnits = units
      return try MLModel(contentsOf: directory.appendingPathComponent(name), configuration: configuration)
    }
    // Never the GPU: a keyboard may only use it in the background role.
    let preprocessor = try load(ModelNames.ASR.preprocessorFile, .cpuOnly)
    let encoder = try load(names.encoder, .cpuAndNeuralEngine)
    let decoder = try load(ModelNames.ASR.decoderFile, .cpuAndNeuralEngine)
    let joint = try load(names.joint, .cpuAndNeuralEngine)
    return AsrModels(
      encoder: encoder, preprocessor: preprocessor, decoder: decoder, joint: joint,
      configuration: AsrModels.defaultConfiguration(),
      vocabulary: try loadVocabulary(directory.appendingPathComponent(ModelNames.ASR.vocabularyFile)),
      version: names.version
    )
  }

  /// The 0.6B vocabularies map token id strings to tokens.
  nonisolated private static func loadVocabulary(_ url: URL) throws -> [Int: String] {
    guard let entries = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: String] else {
      throw CocoaError(.fileReadCorruptFile)
    }
    var vocabulary: [Int: String] = [:]
    for (key, token) in entries {
      if let id = Int(key) { vocabulary[id] = token }
    }
    return vocabulary
  }

  /// The share of the encoder's estimated cost Core ML plans on the Neural Engine; nil when the
  /// plan can't be read or carries no costs.
  nonisolated private static func encoderNeuralShare(in directory: URL) async -> Double? {
    let configuration = AsrModels.defaultConfiguration()
    configuration.computeUnits = .cpuAndNeuralEngine
    let encoder = directory.appendingPathComponent(ModelNames.ASR.encoderFile)
    guard let plan = try? await MLComputePlan.load(contentsOf: encoder, configuration: configuration),
      case let .program(program) = plan.modelStructure
    else { return nil }
    var neural = 0.0
    var total = 0.0
    func visit(_ block: MLModelStructure.Program.Block) {
      for operation in block.operations {
        let weight = plan.estimatedCost(of: operation)?.weight ?? 0
        total += weight
        if case .neuralEngine = plan.deviceUsage(for: operation)?.preferred { neural += weight }
        operation.blocks.forEach(visit)
      }
    }
    program.functions.values.forEach { visit($0.block) }
    return total > 0 ? neural / total : nil
  }

  nonisolated private static var uptime: TimeInterval { ProcessInfo.processInfo.systemUptime }

  nonisolated private static func mb(_ bytes: Int) -> Double { Double(bytes) / Double(megabyte) }
}

private struct TaskCancellable: DirectCancellable {
  let task: Task<Void, Never>?
  func cancel() { task?.cancel() }
}
#elseif OPENWHISPR_KEYBOARD_EXTENSION
// The keyboard target sets OPENWHISPR_KEYBOARD_EXTENSION (withKeyboardExtension.js), and the
// swiftc test harnesses don't. Without this, a keyboard built with FluidAudio unlinked would
// still succeed, with no transcriber, and every Local snapshot would hand off forever.
#error("FluidAudio must be linked into the keyboard target")
#endif

import AVFoundation
import ExpoModulesCore
import FluidAudio
import OrukeetCoreML
import UIKit

/// Options for a single transcription run. Memory sampling is benchmark-only — the production
/// dictation path must not pay the sampler-thread cost.
struct ParakeetTranscribeOptions: Record {
  @Field var language: String? = nil
  @Field var tokenTimings: Bool = false
  @Field var sampleMemory: Bool = false
}

/// The models this module serves. Orukeet is a fine-tune of the v3 architecture, so it runs on the
/// same AsrManager; only its install differs (a pinned archive through OrukeetModelStore instead of
/// FluidAudio's HuggingFace tree).
private enum ParakeetModel: String {
  case v2, v3, orukeet

  var displayName: String {
    switch self {
    case .v2: return "Parakeet v2"
    case .v3: return "Parakeet v3"
    case .orukeet: return "Orukeet"
    }
  }

  /// FluidAudio's table version for the HuggingFace-tree models.
  var asrVersion: AsrModelVersion { self == .v2 ? .v2 : .v3 }
}

// Production wrapper around FluidAudio's Parakeet TDT batch ASR (plus the dev-only benchmark
// memory probes). JS-side callers (LocalParakeetService) serialize prepare/transcribe/release/
// deleteModel on an operation chain, so the warm AsrManager is held as plain instance state.
//
// Verified against FluidAudio 0.15.5-orukeet.1 (the commit plugins/swift-packages pins):
//   Model download is owned by JS (parakeetModelDownloader.ts); this module only reports
//   modelSpec/isModelDownloaded, installs an archive JS downloaded, and loads what is on disk.
//   AsrModels.load(from:version:encoderPrecision:) — loads what JS installed (the ANE-compile
//     half). Not offline by contract: ModelHub.loadModels deletes the repo directory and
//     re-downloads over its own foreground session if an MLModel fails to load, unless
//     ModelHub's offline mode is set — process-global, so it would also stop the diarization
//     module's auto-download; left alone for now.
//   AsrModels.modelsExist(at:version:encoderPrecision:) / defaultCacheDirectory(for:)
//     -> ~/Library/Application Support/FluidAudio/Models/<repo.folderName> (repo-scoped; safe to
//        delete per version; never purged by iOS)
//   Repo.parakeetV2 / .parakeetV3 / .remotePath ; ModelNames.ASR.requiredModels /
//     requiredModelsV3(precision:) / vocabularyFile — the manifest modelSpec hands to JS
//   AsrManager() / loadModels(_:) / decoderLayerCount / transcribe(_ url:, decoderState:, language:)
//     / cleanup()
//   TdtDecoderState.make(decoderLayers:) ; ASRResult { text, confidence, processingTime, tokenTimings }
//     (duration returns 0 on this path — clip length is read from the WAV instead)
//   TokenTiming { token, tokenId, startTime, endTime, confidence } — seconds
//   Language: String-raw enum of ISO codes; the hint drives the v3 decoder's token filter.
//
// Orukeet (OrukeetCoreML at the commit pinned by plugins/swift-packages): used only to install
// and locate the model — OrukeetBundle.int8 (the pinned archive), OrukeetModelStore (only ever
// through OrukeetInstaller) and OrukeetLocalModels.load(from:) -> AsrModels. Transcription stays
// on our AsrManager so meeting notes keep token timings.
public class ParakeetASRModule: Module {
  // int8 is the only precision we ship (applies to v3 only; v2 ignores it). One constant so a
  // future int4 experiment is a one-line change across modelSpec/exists/load.
  private static let encoderPrecision: ParakeetEncoderPrecision = .int8

  // Orukeet's cache lives in a root only this module writes to, so deleting the model can remove
  // the root wholesale. One installer per root: it tracks the install running in it.
  private static let orukeet = OrukeetInstaller(
    home: FileManager.default
      .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
      .appendingPathComponent("OpenWhispr", isDirectory: true)
      .appendingPathComponent("orukeet", isDirectory: true))

  // Warm state: a loaded manager kept between runs so dictation pays load cost once, not per clip.
  private var asr: AsrManager?
  private var loadedModel: ParakeetModel?
  // Standalone sampler used to bracket the Whisper benchmark run (driven from JS) with the SAME
  // probe as Parakeet.
  private let externalSampler = PeakSampler()

  public func definition() -> ModuleDefinition {
    Name("ParakeetASR")

    Events("parakeetInstallProgress")

    // Recover an earlier iOS cache from its retained archive before reclaiming old compiled
    // copies and interrupted work. The installer also tracks this work for cancellation.
    OnCreate {
      Task { await Self.orukeet.removeUnusableCaches() }
    }

    // --- Model management (consent-gated in JS, mirroring the diarization module) ---

    AsyncFunction("isModelDownloaded") { (version: String, promise: Promise) in
      Task {
        do {
          let model = try Self.parseModel(version)
          promise.resolve(await Self.isDownloaded(model))
        } catch {
          promise.reject("MODEL_CHECK_ERROR", error.localizedDescription)
        }
      }
    }

    // UI checks wait for an already-running OS rebuild, so the model picker
    // cannot show Download for a model whose retained source is being compiled.
    // Dictation's existing isModelDownloaded call remains non-blocking.
    AsyncFunction("isModelDownloadedAfterRecovery") { (version: String, promise: Promise) in
      Task {
        do {
          let model = try Self.parseModel(version)
          if model == .orukeet {
            promise.resolve(await Self.orukeet.installedDirectoryAfterRecovery() != nil)
          } else {
            promise.resolve(await Self.isDownloaded(model))
          }
        } catch {
          promise.reject("MODEL_CHECK_ERROR", error.localizedDescription)
        }
      }
    }

    // Everything the JS downloader (src/services/transcription/parakeetModelDownloader.ts) needs
    // to fetch a version. HuggingFace-tree names come from FluidAudio's own tables so the manifest
    // can never drift from the loader; the archive pin comes from OrukeetBundle.
    AsyncFunction("modelSpec") { (version: String, promise: Promise) in
      Task {
        do {
          let model = try Self.parseModel(version)
          promise.resolve(await Self.modelSpec(for: model))
        } catch {
          promise.reject("MODEL_SPEC_ERROR", error.localizedDescription)
        }
      }
    }

    // Verify (size + SHA-256), extract and compile an archive JS downloaded. The archive is never
    // modified or deleted here; JS keeps it for a retry until an install succeeds.
    AsyncFunction("installFromArchive") { (version: String, archivePath: String, promise: Promise) in
      Task {
        do {
          guard try Self.parseModel(version) == .orukeet else {
            throw NSError(
              domain: "ParakeetASR", code: 4,
              userInfo: [
                NSLocalizedDescriptionKey: "Parakeet \(version) is not installed from an archive"
              ])
          }
          let progress: @Sendable (OrukeetModelStore.State) -> Void = { state in
            self.sendEvent(
              "parakeetInstallProgress",
              [
                "version": ParakeetModel.orukeet.rawValue,
                "phase": state.phase.rawValue,
                "fraction": state.fraction,
              ])
          }
          _ = try await Self.orukeet.install(
            fromArchive: URL(fileURLWithPath: archivePath), progress: progress)
          promise.resolve(nil)
        } catch is OrukeetBundle.VerificationError {
          // A distinct code: JS discards an archive that can never pass verification.
          promise.reject(
            "ARCHIVE_VERIFICATION_ERROR",
            "The downloaded model failed verification. Please download it again.")
        } catch {
          // The store's errors name archive entries and Core ML internals; log them, and tell the
          // user what they can act on.
          NSLog("[ParakeetASR] Orukeet install failed: %@", String(describing: error))
          promise.reject(
            "INSTALL_ERROR",
            "Orukeet couldn't be set up on this device. Make sure there's free storage, then try again."
          )
        }
      }
    }

    AsyncFunction("deleteModel") { (version: String, promise: Promise) in
      Task {
        do {
          let model = try Self.parseModel(version)
          if model == .orukeet {
            // Cancellation, joining and removal share one installer operation so
            // another availability check cannot restart OS recovery before delete.
            try await Self.orukeet.deleteModelsAndStaging()
          } else {
            // Repo-scoped directories remove only this version, including its
            // partial JS download; diarization models are stored separately.
            for dir in Self.storageDirectories(for: model)
            where FileManager.default.fileExists(atPath: dir.path) {
              try FileManager.default.removeItem(at: dir)
            }
          }
          if self.loadedModel == model { await self.releaseManager() }
          promise.resolve(nil)
        } catch {
          promise.reject("MODEL_DELETE_ERROR", error.localizedDescription)
        }
      }
    }

    // On-disk footprint of this version: installed weights plus anything a previous attempt left
    // staged. Includes the staged partial download so the reported footprint matches what
    // deleteModel reclaims. Bytes as a Double (safe: sizes are far under 2^53). Returns 0 if
    // nothing is downloaded or staged for this version.
    AsyncFunction("modelSizeBytes") { (version: String) -> Double in
      let model = try Self.parseModel(version)
      return Double(Self.storageDirectories(for: model).reduce(0) { $0 + Self.directorySize($1) })
    }

    // Device context for the benchmark screen so results are interpretable across hardware.
    AsyncFunction("deviceInfo") { () -> [String: Any] in
      return [
        "model": Self.deviceIdentifier(),  // e.g. "iPhone17,1"
        "totalMemoryBytes": Double(ProcessInfo.processInfo.physicalMemory),
        "osVersion": UIDevice.current.systemVersion,
      ]
    }

    // --- Engine lifecycle + transcription ---

    // Load already-downloaded weights and prepare the reusable AsrManager. Orukeet also runs its
    // first prediction here, while the download UI shows "Preparing model…", and discards the
    // silence result/state. loadMs includes that preparation. This module never downloads;
    // FluidAudio's loader can (see the header note on AsrModels.load).
    AsyncFunction("prepare") { (version: String, promise: Promise) in
      Task {
        do {
          let model = try Self.parseModel(version)
          // Drop the previous engine first so two ~600 MB models are never resident together.
          await self.releaseManager()

          let t0 = CFAbsoluteTimeGetCurrent()
          let (models, directory) = try await Self.loadModels(model)
          let manager = AsrManager()
          try await manager.loadModels(models)
          if model == .orukeet {
            do {
              try await OrukeetWarmup.run(on: manager)
            } catch {
              await manager.cleanup()
              throw error
            }
          }
          let loadMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000

          self.asr = manager
          self.loadedModel = model

          promise.resolve([
            "loadMs": loadMs, "modelSizeBytes": Double(Self.directorySize(directory)),
          ])
        } catch {
          promise.reject("PREPARE_ERROR", error.localizedDescription)
        }
      }
    }

    // One transcription on the already-prepared warm manager.
    AsyncFunction("transcribe") {
      (wavUri: String, version: String, options: ParakeetTranscribeOptions, promise: Promise) in
      Task {
        do {
          let model = try Self.parseModel(version)
          guard let manager = self.asr, self.loadedModel == model else {
            throw NSError(
              domain: "ParakeetASR", code: 1,
              userInfo: [
                NSLocalizedDescriptionKey:
                  "prepare(\(version)) must be called before transcribe"
              ])
          }
          let path = wavUri.hasPrefix("file://") ? String(wavUri.dropFirst(7)) : wavUri
          let url = URL(fileURLWithPath: path)
          // FluidAudio's ASRResult.duration comes back 0 on this transcribe path, so measure the
          // clip's true length from the WAV ourselves.
          let audioSeconds = Self.wavDurationSeconds(url) ?? 0

          var sampler: PeakSampler?
          if options.sampleMemory {
            sampler = PeakSampler()
            sampler?.start()
          }
          var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
          // The language hint feeds the v3 decoder's token filter; v2 is English-only and takes
          // no hint. Orukeet was validated with unconditioned decoding (its greedy joint exports no
          // top-K for the filter to use), so it takes none either. Unknown codes fall back to nil
          // (auto language ID).
          let language: Language? =
            (model == .v3) ? options.language.flatMap { Language(rawValue: $0) } : nil
          let result = try await manager.transcribe(url, decoderState: &state, language: language)
          let mem = sampler?.stop()

          let inferSeconds = result.processingTime
          var payload: [String: Any] = [
            "text": result.text,
            "confidence": Double(result.confidence),
            "rtfx": inferSeconds > 0 ? audioSeconds / inferSeconds : 0,
            "inferMs": inferSeconds * 1000,
            "audioSeconds": audioSeconds,
          ]
          if options.tokenTimings {
            payload["tokenTimings"] = (result.tokenTimings ?? []).map { timing in
              [
                "token": timing.token,
                "startTime": timing.startTime,
                "endTime": timing.endTime,
                "confidence": Double(timing.confidence),
              ]
            }
          }
          if let mem {
            payload["peakBytes"] = Double(mem.peak)
            payload["baselineBytes"] = Double(mem.baseline)
            payload["minAvailableBytes"] = Double(mem.minAvailable)
          }
          promise.resolve(payload)
        } catch {
          promise.reject("TRANSCRIBE_ERROR", error.localizedDescription)
        }
      }
    }

    // Release the warm manager + its CoreML models (frees ~600 MB when another engine or the
    // system needs the memory; also how JS-side cancellation discards an in-flight engine).
    AsyncFunction("release") { (promise: Promise) in
      Task {
        await self.releaseManager()
        promise.resolve(nil)
      }
    }

    // --- Memory probe exposed for the Whisper benchmark run (measured with the identical sampler) ---

    AsyncFunction("startMemorySampling") { () in
      self.externalSampler.start()
    }

    AsyncFunction("stopMemorySampling") { () -> [String: Any] in
      let mem = self.externalSampler.stop()
      return [
        "peakBytes": Double(mem.peak),
        "baselineBytes": Double(mem.baseline),
        "minAvailableBytes": Double(mem.minAvailable),
      ]
    }
  }

  // MARK: - Helpers

  // AsrManager is an actor, so cleanup() is actor-isolated and must be awaited.
  private func releaseManager() async {
    await asr?.cleanup()
    asr = nil
    loadedModel = nil
  }

  private static func parseModel(_ s: String) throws -> ParakeetModel {
    guard let model = ParakeetModel(rawValue: s) else {
      throw NSError(
        domain: "ParakeetASR", code: 2,
        userInfo: [
          NSLocalizedDescriptionKey: "Unknown Parakeet version '\(s)' (expected v2, v3 or orukeet)"
        ])
    }
    return model
  }

  private static func isDownloaded(_ model: ParakeetModel) async -> Bool {
    switch model {
    case .v2, .v3:
      return AsrModels.modelsExist(
        at: AsrModels.defaultCacheDirectory(for: model.asrVersion), version: model.asrVersion,
        encoderPrecision: encoderPrecision)
    case .orukeet:
      return await orukeet.installedDirectory() != nil
    }
  }

  private static func modelSpec(for model: ParakeetModel) async -> [String: Any] {
    switch model {
    case .v2, .v3:
      let v = model.asrVersion
      let bundles: Set<String> =
        (v == .v3)
        ? ModelNames.ASR.requiredModelsV3(precision: encoderPrecision)
        : ModelNames.ASR.requiredModels
      return [
        "kind": "hf-tree",
        "repo": (v == .v3 ? Repo.parakeetV3 : Repo.parakeetV2).remotePath,
        "directory": AsrModels.defaultCacheDirectory(for: v).path,
        "stagingDirectory": stagingDirectory(for: model).path,
        "entries": bundles.sorted() + [ModelNames.ASR.vocabularyFile],
      ]
    case .orukeet:
      let bundle = OrukeetBundle.int8
      let installed = await orukeet.installedDirectory()
      return [
        "kind": "archive",
        "archiveUrl": bundle.url.absoluteString,
        "archiveBytes": Double(bundle.bytes),
        "archiveSha256": bundle.sha256,
        "stagingDirectory": stagingDirectory(for: model).path,
        "installedDirectory": installed.map { $0.path as Any } ?? NSNull(),
      ]
    }
  }

  /// Load a downloaded model's weights, plus the directory they came from (for its size).
  private static func loadModels(_ model: ParakeetModel) async throws -> (AsrModels, URL) {
    let notDownloaded = NSError(
      domain: "ParakeetASR", code: 3,
      userInfo: [
        NSLocalizedDescriptionKey:
          "\(model.displayName) model is not downloaded. Please download it first."
      ])
    switch model {
    case .v2, .v3:
      let v = model.asrVersion
      let dir = AsrModels.defaultCacheDirectory(for: v)
      guard AsrModels.modelsExist(at: dir, version: v, encoderPrecision: encoderPrecision) else {
        throw notDownloaded
      }
      return (
        try await AsrModels.load(from: dir, version: v, encoderPrecision: encoderPrecision), dir
      )
    case .orukeet:
      guard let dir = await orukeet.installedDirectory() else { throw notDownloaded }
      return (try OrukeetLocalModels.load(from: dir), dir)
    }
  }

  /// Where a model is installed: FluidAudio's repo-scoped directory, or Orukeet's own root.
  private static func installRoot(for model: ParakeetModel) -> URL {
    model == .orukeet ? orukeet.modelsRoot : AsrModels.defaultCacheDirectory(for: model.asrVersion)
  }

  /// Everything on disk for a model: its install root and the JS staging sibling.
  private static func storageDirectories(for model: ParakeetModel) -> [URL] {
    [installRoot(for: model), stagingDirectory(for: model)]
  }

  /// True audio length of the WAV in seconds, read from the file itself — used for RTF because
  /// FluidAudio's ASRResult.duration returns 0 on this transcription path.
  private static func wavDurationSeconds(_ url: URL) -> Double? {
    guard let file = try? AVAudioFile(forReading: url) else { return nil }
    let sampleRate = file.processingFormat.sampleRate
    guard sampleRate > 0 else { return nil }
    return Double(file.length) / sampleRate
  }

  /// Where the JS downloader stages an in-progress transfer: the install root's path with
  /// ".downloading" appended. Orukeet's installer owns its staging URL and deletion;
  /// JS reads the path from `modelSpec` instead of rebuilding it. Staging is kept between attempts so completed files are
  /// reused, which also means a failed run leaves it behind.
  private static func stagingDirectory(for model: ParakeetModel) -> URL {
    model == .orukeet
      ? orukeet.stagingDirectory
      : URL(fileURLWithPath: installRoot(for: model).path + ".downloading")
  }

  /// Recursive sum of file sizes under `dir` (`.mlmodelc` are directories of weight files). 0 if absent.
  private static func directorySize(_ dir: URL) -> UInt64 {
    let fm = FileManager.default
    guard let en = fm.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey])
    else { return 0 }
    var total: UInt64 = 0
    for case let url as URL in en {
      let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
      if values?.isRegularFile == true, let size = values?.fileSize { total += UInt64(size) }
    }
    return total
  }

  private static func deviceIdentifier() -> String {
    var sysinfo = utsname()
    uname(&sysinfo)
    let mirror = Mirror(reflecting: sysinfo.machine)
    return mirror.children.reduce(into: "") { result, element in
      guard let value = element.value as? Int8, value != 0 else { return }
      result.append(Character(UnicodeScalar(UInt8(value))))
    }
  }
}

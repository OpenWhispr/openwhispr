import AVFoundation
import ExpoModulesCore
import FluidAudio
import UIKit

/// Options for a single transcription run. Memory sampling is benchmark-only — the production
/// dictation path must not pay the sampler-thread cost.
struct ParakeetTranscribeOptions: Record {
  @Field var language: String? = nil
  @Field var tokenTimings: Bool = false
  @Field var sampleMemory: Bool = false
}

// Production wrapper around FluidAudio's Parakeet TDT batch ASR (plus the dev-only benchmark
// memory probes). JS-side callers (LocalParakeetService) serialize prepare/transcribe/release/
// deleteModel on an operation chain, so the warm AsrManager is held as plain instance state.
//
// Verified against FluidAudio 0.15.4 (the version already pinned by the diarization plugin):
//   Model download is owned by JS (parakeetModelDownloader.ts); this module only reports
//   modelSpec/modelsExist/defaultCacheDirectory and loads what is already on disk.
//   AsrModels.load(from:version:encoderPrecision:) — loads what JS installed (the ANE-compile
//     half). Not offline by contract: 0.15.4's DownloadUtils.loadModels deletes the repo directory
//     and re-downloads over its own foreground session if an MLModel fails to load, unless
//     DownloadUtils.enforceOffline is set — process-global, so it would also stop the diarization
//     module's auto-download; left alone for now.
//   AsrModels.modelsExist(at:version:encoderPrecision:) / defaultCacheDirectory(for:)
//     -> ~/Library/Application Support/FluidAudio/Models/<repo.folderName> (repo-scoped; safe to
//        delete per version; never purged by iOS)
//   Repo.parakeetV2 / .parakeetV3 / .remotePath ; ModelNames.ASR.requiredModels /
//     requiredModelsV3(precision:) / vocabularyFile — the manifest modelSpec hands to JS
//   AsrManager() / loadModels(_:) / transcribe(_ url:, decoderState:, language:) / cleanup()
//   TdtDecoderState.make() ; ASRResult { text, confidence, processingTime, tokenTimings }
//     (duration returns 0 on this path — clip length is read from the WAV instead)
//   TokenTiming { token, tokenId, startTime, endTime, confidence } — seconds
//   Language: String-raw enum of ISO codes; the hint drives the v3 decoder's token filter.
public class ParakeetASRModule: Module {
  // int8 is the only precision we ship (applies to v3 only; v2 ignores it). One constant so a
  // future int4 experiment is a one-line change across modelSpec/exists/load.
  private static let encoderPrecision: ParakeetEncoderPrecision = .int8

  // Warm state: a loaded manager kept between runs so dictation pays load cost once, not per clip.
  private var asr: AsrManager?
  private var loadedVersion: AsrModelVersion?
  // Standalone sampler used to bracket the Whisper benchmark run (driven from JS) with the SAME
  // probe as Parakeet.
  private let externalSampler = PeakSampler()

  public func definition() -> ModuleDefinition {
    Name("ParakeetASR")

    // --- Model management (consent-gated in JS, mirroring the diarization module) ---

    AsyncFunction("isModelDownloaded") { (version: String) -> Bool in
      let v = try Self.parseVersion(version)
      return AsrModels.modelsExist(
        at: AsrModels.defaultCacheDirectory(for: v), version: v,
        encoderPrecision: Self.encoderPrecision)
    }

    // Everything the JS downloader (src/services/transcription/parakeetModelDownloader.ts) needs
    // to fetch a version's weights into the exact layout AsrModels.load/modelsExist expect. The
    // names come from FluidAudio's own tables so the manifest can never drift from the loader.
    AsyncFunction("modelSpec") { (version: String) -> [String: Any] in
      let v = try Self.parseVersion(version)
      let repo: Repo = (v == .v3) ? .parakeetV3 : .parakeetV2
      let bundles: Set<String> =
        (v == .v3)
        ? ModelNames.ASR.requiredModelsV3(precision: Self.encoderPrecision)
        : ModelNames.ASR.requiredModels
      return [
        "repo": repo.remotePath,
        "directory": AsrModels.defaultCacheDirectory(for: v).path,
        "stagingDirectory": Self.stagingDirectory(for: v).path,
        "entries": bundles.sorted() + [ModelNames.ASR.vocabularyFile],
      ]
    }

    AsyncFunction("deleteModel") { (version: String, promise: Promise) in
      Task {
        do {
          let v = try Self.parseVersion(version)
          // Repo-scoped dir (…/Models/parakeet-tdt-0.6b-v{2,3}) — removing it frees only this
          // version's weights and never touches the diarization models (a different repo folder).
          let dir = AsrModels.defaultCacheDirectory(for: v)
          if FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.removeItem(at: dir)
          }
          // A failed or cancelled download leaves partial weights (up to ~460 MB) in the JS staging
          // sibling; "Delete model" is the only thing that reclaims them.
          let staging = Self.stagingDirectory(for: v)
          if FileManager.default.fileExists(atPath: staging.path) {
            try FileManager.default.removeItem(at: staging)
          }
          if self.loadedVersion == v { await self.releaseManager() }
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
      let v = try Self.parseVersion(version)
      return Double(
        Self.directorySize(AsrModels.defaultCacheDirectory(for: v))
          + Self.directorySize(Self.stagingDirectory(for: v)))
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

    // Load already-downloaded weights + build the warm AsrManager. The first load after a download
    // is where CoreML's one-time ANE compile happens (~seconds), and the download UI owns that wait
    // ("Preparing model…") — a dictation tap must never pay it. This module never downloads;
    // FluidAudio's loader can (see the header note on AsrModels.load).
    AsyncFunction("prepare") { (version: String, promise: Promise) in
      Task {
        do {
          let v = try Self.parseVersion(version)
          let dir = AsrModels.defaultCacheDirectory(for: v)
          guard AsrModels.modelsExist(at: dir, version: v, encoderPrecision: Self.encoderPrecision)
          else {
            throw NSError(
              domain: "ParakeetASR", code: 3,
              userInfo: [
                NSLocalizedDescriptionKey:
                  "Parakeet \(version) model is not downloaded. Please download it first."
              ])
          }
          let t0 = CFAbsoluteTimeGetCurrent()
          let models = try await AsrModels.load(
            from: dir, version: v, encoderPrecision: Self.encoderPrecision)
          let manager = AsrManager()
          try await manager.loadModels(models)
          let loadMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000

          await self.releaseManager()  // drop any previous engine before holding the new one
          self.asr = manager
          self.loadedVersion = v

          promise.resolve(["loadMs": loadMs, "modelSizeBytes": Double(Self.directorySize(dir))])
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
          let v = try Self.parseVersion(version)
          guard let manager = self.asr, self.loadedVersion == v else {
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
          var state = TdtDecoderState.make()  // v2/v3 both use 2 decoder layers (the default)
          // The language hint feeds the v3 decoder's token filter; v2 is English-only and takes
          // no hint. Unknown codes fall back to nil (auto language ID).
          let language: Language? =
            (v == .v3) ? options.language.flatMap { Language(rawValue: $0) } : nil
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
    loadedVersion = nil
  }

  private static func parseVersion(_ s: String) throws -> AsrModelVersion {
    switch s {
    case "v2": return .v2
    case "v3": return .v3
    default:
      throw NSError(
        domain: "ParakeetASR", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Unknown Parakeet version '\(s)' (expected v2 or v3)"])
    }
  }

  /// True audio length of the WAV in seconds, read from the file itself — used for RTF because
  /// FluidAudio's ASRResult.duration returns 0 on this transcription path.
  private static func wavDurationSeconds(_ url: URL) -> Double? {
    guard let file = try? AVAudioFile(forReading: url) else { return nil }
    let sampleRate = file.processingFormat.sampleRate
    guard sampleRate > 0 else { return nil }
    return Double(file.length) / sampleRate
  }

  /// Where the JS downloader stages an in-progress transfer: the install directory's path with
  /// ".downloading" appended. The only definition of that suffix — JS reads the path from
  /// `modelSpec` instead of rebuilding it. Staging is kept between attempts so completed files are
  /// reused, which also means a failed run leaves it behind.
  private static func stagingDirectory(for v: AsrModelVersion) -> URL {
    URL(fileURLWithPath: AsrModels.defaultCacheDirectory(for: v).path + ".downloading")
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

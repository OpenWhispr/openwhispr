import ExpoModulesCore
import FluidAudio

// On-device speaker diarization over FluidAudio's OFFLINE pipeline (OfflineDiarizerManager).
//
// Why offline (not DiarizerManager): only the offline pipeline honors a speaker-COUNT hint
// (KMeans/VBx via `config.withSpeakers(exactly:)`). The streaming DiarizerManager is threshold-only
// and ignores the count, so it under-splits similar voices.
//
// Audio is fed via `process(_ url:)` — FluidAudio's memory-mapped/streaming disk source — so a long
// meeting recording is NOT loaded into a full [Float] buffer (avoids OOM on real-length audio).
//
// Verified against FluidAudio 0.15.4: OfflineDiarizerConfig.default, .withSpeakers(exactly:),
// OfflineDiarizerManager(config:)/initialize(models:)/process(_:) async -> DiarizationResult,
// OfflineDiarizerModels.load() (auto-downloads the offline-variant models) + .defaultModelsDirectory().
public class SpeakerDiarizationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SpeakerDiarization")

    // Consent-gated model management. JS calls isModelDownloaded() and, if false, prompts before
    // downloadModel(). downloadModel() loads (and downloads if missing) the offline models.
    AsyncFunction("isModelDownloaded") { (promise: Promise) in
      promise.resolve(Self.modelsCached())
    }

    AsyncFunction("downloadModel") { (promise: Promise) in
      Task {
        do {
          _ = try await OfflineDiarizerModels.load() // downloads the offline-variant models if missing
          promise.resolve(nil)
        } catch {
          promise.reject("MODEL_DOWNLOAD_ERROR", error.localizedDescription)
        }
      }
    }

    // Reclaim the ~100 MB of weights. Removes every artifact modelsCached() checks for, across the
    // same candidate dirs, so isModelDownloaded() reports false afterward and the consent prompt re-runs.
    AsyncFunction("deleteModel") { (promise: Promise) in
      let base = OfflineDiarizerModels.defaultModelsDirectory()
      let fm = FileManager.default
      do {
        // Model artifacts that may live directly under the models directory.
        for file in Self.requiredModelArtifacts {
          let path = base.appendingPathComponent(file)
          if fm.fileExists(atPath: path.path) { try fm.removeItem(at: path) }
        }
        // ...and the repo subfolders FluidAudio may nest them in.
        for dir in Self.modelRepoSubdirs(base) where fm.fileExists(atPath: dir.path) {
          try fm.removeItem(at: dir)
        }
        promise.resolve(nil)
      } catch {
        promise.reject("MODEL_DELETE_ERROR", error.localizedDescription)
      }
    }

    AsyncFunction("diarize") { (wavUri: String, numberOfSpeakers: Int, promise: Promise) in
      Task {
        do {
          // Consent-gating lives in the JS layer (isModelDownloaded() -> prompt -> downloadModel()).
          // load() below loads the offline models from disk, downloading them only if still missing.
          let path = wavUri.hasPrefix("file://") ? String(wavUri.dropFirst(7)) : wavUri

          // Exact-or-auto count hint: >0 forces exactly N speakers; 0 leaves auto-detection.
          var config = OfflineDiarizerConfig.default
          if numberOfSpeakers > 0 {
            config = config.withSpeakers(exactly: numberOfSpeakers)
          }

          let manager = OfflineDiarizerManager(config: config)
          let models = try await OfflineDiarizerModels.load()
          manager.initialize(models: models)

          // Stream from the file (memory-mapped, chunked) rather than reading the whole recording
          // into memory. FluidAudio converts to its target sample rate internally.
          let result = try await manager.process(URL(fileURLWithPath: path))

          let segments = result.segments.map { seg -> [String: Any] in
            [
              "startTime": Double(seg.startTimeSeconds), // seconds
              "endTime": Double(seg.endTimeSeconds),     // seconds
              "speakerId": seg.speakerId,        // String, e.g. "Speaker 1"
              "embedding": seg.embedding.map { Double($0) },
            ]
          }
          var payload: [String: Any] = [
            "segments": segments,
          ]
          if let speakerDatabase = result.speakerDatabase {
            payload["speakerDatabase"] = speakerDatabase.mapValues { vector in
              vector.map { Double($0) }
            }
          }
          promise.resolve(payload)
        } catch {
          promise.reject("DIARIZE_ERROR", error.localizedDescription)
        }
      }
    }
  }

  // Whether the OFFLINE diarization weights are fully on disk (so diarize() needs no network).
  // Requires ALL of the offline model artifacts to be present — a partial/interrupted download
  // returns false (so the consent prompt re-runs) rather than passing readiness and then
  // downloading mid-diarize. Filenames are the offline variant (FluidAudio 0.15.4 `ModelNames.OfflineDiarizer`);
  // the files land under Models/ or a repo subfolder, so each is searched across the candidate dirs.
  // The offline-variant artifacts (FluidAudio 0.15.4 `ModelNames.OfflineDiarizer`). Shared by the
  // readiness check and deleteModel() so they stay in sync. `.mlmodelc` entries are directories.
  static let requiredModelArtifacts = [
    "Segmentation.mlmodelc",
    "FBank.mlmodelc",
    "Embedding.mlmodelc",
    "PldaRho.mlmodelc",
    "plda-parameters.json",
  ]

  // The weights land under the models dir itself or one of these repo subfolders, so both the
  // readiness check and deletion search across all of them.
  static func modelRepoSubdirs(_ base: URL) -> [URL] {
    [
      base.appendingPathComponent("speaker-diarization-coreml"),
      base.appendingPathComponent("speaker-diarization"),
      base.appendingPathComponent("speaker-diarization-offline"),
    ]
  }

  static func modelsCached() -> Bool {
    let base = OfflineDiarizerModels.defaultModelsDirectory()
    let fm = FileManager.default
    let dirs = [base] + modelRepoSubdirs(base)
    return requiredModelArtifacts.allSatisfy { file in
      dirs.contains { fm.fileExists(atPath: $0.appendingPathComponent(file).path) }
    }
  }
}

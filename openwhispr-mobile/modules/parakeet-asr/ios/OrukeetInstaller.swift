import Foundation
import OrukeetCoreML

/// Owns every call into OrukeetModelStore. The store holds its actor for a whole install (verify,
/// extract and compile never suspend), so anything that asked it a question mid-install — every
/// dictation's "is Orukeet installed?" — would wait for the install to finish. This actor answers
/// from its own state instead.
///
/// Everything Orukeet stores lives under `home`, which is excluded from backup: the store's
/// `models` root and, beside it, the staging directory the JS download writes the archive into.
actor OrukeetInstaller {
  nonisolated let modelsRoot: URL
  private let store: OrukeetModelStore
  private var running: Task<URL, Error>?

  init(home: URL) {
    modelsRoot = home.appendingPathComponent("models", isDirectory: true)
    store = OrukeetModelStore(rootDirectory: modelsRoot)
    do {
      try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var directory = home
      try directory.setResourceValues(values)
    } catch {
      NSLog("[ParakeetASR] Could not exclude Orukeet from backup: %@", error.localizedDescription)
    }
  }

  /// The verified install, or nil. Also nil while an install runs, rather than waiting for it.
  func installedDirectory() async -> URL? {
    guard running == nil else { return nil }
    do {
      return try await store.installedDirectory()
    } catch {
      NSLog("[ParakeetASR] Orukeet install is not usable: %@", error.localizedDescription)
      return nil
    }
  }

  /// Verify (size + SHA-256), extract and compile a downloaded archive. The archive is never
  /// modified or deleted.
  func install(
    fromArchive archive: URL, progress: @escaping @Sendable (OrukeetModelStore.State) -> Void
  ) async throws -> URL {
    guard running == nil else { throw OrukeetModelStore.StoreError.busy }
    let task = Task { [store, modelsRoot] in
      do {
        _ = try await store.installedDirectory()
      } catch OrukeetModelStore.StoreError.invalidInstallation(let detail) {
        // The store refuses to replace an install it can't validate, which would leave every
        // re-download failing; nothing but Orukeet caches lives in this root.
        NSLog("[ParakeetASR] Replacing an invalid Orukeet install: %@", detail)
        try FileManager.default.removeItem(at: modelsRoot)
      }
      let installed = try await store.install(fromArchive: archive, progress: progress)
      Self.removeEverything(in: modelsRoot, except: installed)
      return installed
    }
    running = task
    defer { running = nil }
    return try await task.value
  }

  /// Stop a running install at its next checkpoint and wait for it to unwind.
  func cancelInstall() async {
    guard let running else { return }
    running.cancel()
    _ = await running.result
  }

  /// Reclaim caches this build can never load: ones keyed to an earlier iOS build and work
  /// directories an interrupted install left behind. Nothing is removed while an install runs,
  /// or when the install on disk can't be read (it might be valid).
  func removeUnusableCaches() async {
    guard running == nil else { return }
    let installed: URL?
    do {
      installed = try await store.installedDirectory()
    } catch {
      return
    }
    // An install may have started while the store answered.
    guard running == nil else { return }
    Self.removeEverything(in: modelsRoot, except: installed)
  }

  private static func removeEverything(in root: URL, except keep: URL?) {
    let entries =
      (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
    for entry in entries where entry.lastPathComponent != keep?.lastPathComponent {
      try? FileManager.default.removeItem(at: entry)
    }
  }
}

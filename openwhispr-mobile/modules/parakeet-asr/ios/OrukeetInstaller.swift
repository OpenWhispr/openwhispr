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
  nonisolated let stagingDirectory: URL
  private let store: OrukeetModelStore
  private var running: Task<URL?, Error>?
  private var recovering = false
  private var deleting: Task<Void, Error>?

  init(home: URL) {
    modelsRoot = home.appendingPathComponent("models", isDirectory: true)
    stagingDirectory = URL(fileURLWithPath: modelsRoot.path + ".downloading", isDirectory: true)
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
    guard running == nil, deleting == nil else { return nil }
    do {
      return try await findInstalled(prune: false)
    } catch {
      NSLog("[ParakeetASR] Orukeet install is not usable: %@", error.localizedDescription)
      return nil
    }
  }

  /// The model picker can show a loading indicator while a startup OS rebuild
  /// finishes. Dictation continues using the non-blocking check above. Waiting
  /// for this shared recovery does not cancel it when an individual UI closes.
  func installedDirectoryAfterRecovery() async -> URL? {
    guard deleting == nil else { return nil }
    do {
      let installed: URL?
      if let running {
        guard recovering else { return nil }
        installed = try await running.value
      } else {
        installed = try await findInstalled(prune: true)
      }
      // Delete can finish before this shared recovery waiter resumes. Do not
      // turn its completed task's now-stale URL into an Installed UI state.
      guard let installed, !Task.isCancelled, deleting == nil,
        FileManager.default.fileExists(atPath: installed.path) else { return nil }
      return installed
    } catch {
      NSLog("[ParakeetASR] Orukeet recovery is not usable: %@", error.localizedDescription)
      return nil
    }
  }

  /// Verify (size + SHA-256), extract and compile a downloaded archive. The archive is never
  /// modified or deleted.
  func install(
    fromArchive archive: URL, progress: @escaping @Sendable (OrukeetModelStore.State) -> Void
  ) async throws -> URL {
    guard running == nil, deleting == nil else { throw OrukeetModelStore.StoreError.busy }
    try Task.checkCancellation()
    let task = Task<URL?, Error> { [store, modelsRoot] in
      do {
        _ = try await store.installedDirectory()
      } catch OrukeetModelStore.StoreError.invalidInstallation(let detail) {
        // The store refuses to replace an install it can't validate, which would leave every
        // re-download failing; nothing but Orukeet caches lives in this root.
        NSLog("[ParakeetASR] Replacing an invalid Orukeet install: %@", detail)
        try FileManager.default.removeItem(at: modelsRoot)
      }
      let installed = try await store.install(fromArchive: archive, progress: progress)
      try Task.checkCancellation()
      Self.removeEverything(in: modelsRoot, except: installed)
      return installed
    }
    running = task
    defer { running = nil }
    let installed = try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
    guard let installed else {
      throw OrukeetModelStore.StoreError.invalidInstallation("Install returned no model directory")
    }
    return installed
  }

  /// Stop a running install at its next checkpoint and wait for it to unwind.
  func cancelInstall() async {
    guard let running else { return }
    running.cancel()
    _ = await running.result
  }

  /// Cancel and join all work before deleting model files. Keep deletion inside
  /// this actor: a separate cancel-then-delete call permits another availability
  /// check to start recompiling in the gap. The dedicated home stays in place so
  /// its backup exclusion also covers a later JS staging download.
  func deleteModelsAndStaging() async throws {
    if let deleting {
      try await deleting.value
      return
    }
    try Task.checkCancellation()
    let active = running
    let task = Task<Void, Error> { [modelsRoot, stagingDirectory] in
      active?.cancel()
      if let active { _ = await active.result }
      try Task.checkCancellation()
      let files = FileManager.default
      for directory in [modelsRoot, stagingDirectory] where files.fileExists(atPath: directory.path) {
        try files.removeItem(at: directory)
      }
    }
    deleting = task
    defer { deleting = nil }
    try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }

  /// Recompile from the retained portable archive after an iOS update, then reclaim the old
  /// compiled cache and interrupted work. A failed recovery preserves the source for a retry.
  func removeUnusableCaches() async {
    guard running == nil, deleting == nil else { return }
    do {
      _ = try await findInstalled(prune: true)
    } catch {
      return
    }
  }

  /// Directory lookup can now compile models after an OS update. Track it just like an install:
  /// concurrent availability checks remain non-blocking, and Delete waits for it to unwind.
  private func findInstalled(prune: Bool) async throws -> URL? {
    guard running == nil, deleting == nil else { return nil }
    try Task.checkCancellation()
    let task = Task<URL?, Error> { [store, modelsRoot] in
      let installed = try await store.installedDirectory()
      try Task.checkCancellation()
      if prune { Self.removeEverything(in: modelsRoot, except: installed) }
      return installed
    }
    running = task
    recovering = true
    defer { running = nil; recovering = false }
    return try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }

  private static func removeEverything(in root: URL, except keep: URL?) {
    let entries =
      (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
    for entry in entries where entry.lastPathComponent != keep?.lastPathComponent {
      try? FileManager.default.removeItem(at: entry)
    }
  }
}

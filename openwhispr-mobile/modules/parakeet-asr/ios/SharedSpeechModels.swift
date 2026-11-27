import FluidAudio
import Foundation

/// Where the app keeps Parakeet weights: in the App Group container, so the keyboard extension
/// loads the very copy the app downloaded instead of needing its own.
///
/// Path shape (the keyboard builds this same path itself from the folder names below, without
/// importing this module, so the two must never drift):
///
///     <App Group container>/Library/Application Support/SpeechModels/<folder name>
///     v2: parakeet-tdt-0.6b-v2
///     v3: parakeet-tdt-0.6b-v3
///
/// The folder name is FluidAudio's `Repo.folderName`, which its loader requires: `AsrModels.load`
/// and `modelsExist` read the files from `directory.deletingLastPathComponent()/<folderName>`,
/// so any other last component would load nothing. In 0.15.4 that is the Hugging Face repo name
/// without its `-coreml` suffix, and the last component of `AsrModels.defaultCacheDirectory`, so
/// the legacy move below keeps the same name.
///
/// Staging for a download in progress is the same path with ".downloading" appended: a sibling in
/// the same folder, so the downloader's final move is a same-volume rename and a keyboard loading
/// at that moment never sees a half-written set.
///
/// `SpeechModels` is excluded from backup (it holds ~0.5 GB per version that can be downloaded
/// again), which covers everything inside it.
enum SharedSpeechModels {
  static let v2FolderName = "parakeet-tdt-0.6b-v2"
  static let v3FolderName = "parakeet-tdt-0.6b-v3"

  private static let stagingSuffix = ".downloading"

  /// The App Group install directory for `version`, or nil when the App Group container is
  /// unavailable (simulator without the entitlement, unsigned builds).
  static func directory(for version: AsrModelVersion, appGroupId: String) -> URL? {
    guard let root = speechModelsRoot(appGroupId: appGroupId) else { return nil }
    return root.appendingPathComponent(folderName(for: version), isDirectory: true)
  }

  /// Where the JS downloader stages a transfer for `version`; nil when `directory` is nil.
  static func stagingDirectory(for version: AsrModelVersion, appGroupId: String) -> URL? {
    directory(for: version, appGroupId: appGroupId).map(staging(of:))
  }

  /// The directory the app installs to and loads from: the App Group one, or FluidAudio's own
  /// cache directory when there is no App Group container, so those builds keep working.
  static func resolvedDirectory(for version: AsrModelVersion, appGroupId: String) -> URL {
    directory(for: version, appGroupId: appGroupId)
      ?? AsrModels.defaultCacheDirectory(for: version)
  }

  /// Staging beside `resolvedDirectory`.
  static func resolvedStagingDirectory(for version: AsrModelVersion, appGroupId: String) -> URL {
    staging(of: resolvedDirectory(for: version, appGroupId: appGroupId))
  }

  /// Moves weights an earlier build left in FluidAudio's cache directory (inside the app's own
  /// container, which the keyboard can't read) into the App Group, along with any staged partial
  /// download so it can resume. Never downloads. Leaves the old folder alone when the App Group
  /// already holds this version; once migrated it costs one `fileExists` per folder.
  static func migrateLegacy(version: AsrModelVersion, appGroupId: String) {
    guard let target = directory(for: version, appGroupId: appGroupId) else { return }
    let legacy = AsrModels.defaultCacheDirectory(for: version)
    moveIfNeeded(from: legacy, to: target)
    moveIfNeeded(from: staging(of: legacy), to: staging(of: target))
  }

  /// Removes the old FluidAudio-cache copy and its staging folder for `version`. `moveIfNeeded`
  /// leaves them when the App Group holds the version too, so without this a deleted model's old
  /// copy would be moved back in by the next `migrateLegacy`, and stay on disk meanwhile. A
  /// failure is logged, never thrown: the delete itself already succeeded.
  static func removeLegacy(version: AsrModelVersion) {
    let fm = FileManager.default
    let legacy = AsrModels.defaultCacheDirectory(for: version)
    for url in [legacy, staging(of: legacy)] where fm.fileExists(atPath: url.path) {
      do {
        try fm.removeItem(at: url)
      } catch {
        NSLog(
          "[ParakeetASR] Could not remove legacy %@: %@", url.lastPathComponent,
          error.localizedDescription)
      }
    }
  }

  // MARK: - Helpers

  private static func folderName(for version: AsrModelVersion) -> String {
    switch version {
    case .v2: return v2FolderName
    case .v3: return v3FolderName
    default: return AsrModels.defaultCacheDirectory(for: version).lastPathComponent
    }
  }

  private static func staging(of directory: URL) -> URL {
    URL(fileURLWithPath: directory.path + stagingSuffix, isDirectory: true)
  }

  /// `<container>/Library/Application Support/SpeechModels`, created and excluded from backup on
  /// first use. Nil without an App Group container, or if the folder can't be created.
  private static func speechModelsRoot(appGroupId: String) -> URL? {
    let fm = FileManager.default
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    else { return nil }
    var root =
      container
      .appendingPathComponent("Library", isDirectory: true)
      .appendingPathComponent("Application Support", isDirectory: true)
      .appendingPathComponent("SpeechModels", isDirectory: true)
    if !fm.fileExists(atPath: root.path) {
      do {
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
      } catch {
        NSLog("[ParakeetASR] Could not create %@: %@", root.path, error.localizedDescription)
        return nil
      }
    }
    excludeFromBackup(&root)
    return root
  }

  private static func moveIfNeeded(from source: URL, to destination: URL) {
    let fm = FileManager.default
    guard fm.fileExists(atPath: source.path), !fm.fileExists(atPath: destination.path) else {
      return
    }
    do {
      try fm.moveItem(at: source, to: destination)
      var moved = destination
      excludeFromBackup(&moved)
    } catch {
      NSLog(
        "[ParakeetASR] Could not move %@ to the App Group: %@", source.lastPathComponent,
        error.localizedDescription)
    }
  }

  private static func excludeFromBackup(_ url: inout URL) {
    if (try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup == true {
      return
    }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
      try url.setResourceValues(values)
    } catch {
      NSLog("[ParakeetASR] Could not exclude %@ from backup: %@", url.path, error.localizedDescription)
    }
  }
}

import Foundation
import OrukeetCoreML

private enum RegressionFailure: Error { case assertion(String) }
private func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw RegressionFailure.assertion(message) }
}

private struct Fixture {
  let root: URL
  let home: URL
  let archive: URL
  let old: URL
  let abandoned: URL
  let installer: OrukeetInstaller

  init() throws {
    let files = FileManager.default
    let scratch = ProcessInfo.processInfo.environment["ORUKEET_INSTALLER_REGRESSION_ROOT"]
      .map { URL(fileURLWithPath: $0) } ?? files.temporaryDirectory
    root = scratch.appendingPathComponent("orukeet-installer-regression-\(UUID())")
    home = root.appendingPathComponent("orukeet")
    archive = root.appendingPathComponent("caller.zip")
    installer = OrukeetInstaller(home: home)
    old = installer.modelsRoot.appendingPathComponent("previous-os")
    abandoned = installer.modelsRoot.appendingPathComponent(".orukeet-work-interrupted")
    for directory in [old, abandoned, installer.stagingDirectory] {
      try files.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    try Data("source".utf8).write(to: old.appendingPathComponent("orukeet-source.zip"))
    try Data("caller".utf8).write(to: archive)
    try Data("partial".utf8).write(to: installer.stagingDirectory.appendingPathComponent("partial.zip"))
  }

  func cleanup() { try? FileManager.default.removeItem(at: root) }
}

@main
struct InstallerRegression {
  static func main() async throws {
    var checks: [String] = []

    do {
      let f = try Fixture()
      defer { f.cleanup() }
      await SDKProbe.shared.configure(.recover, blocked: true)
      let recovery = Task { await f.installer.installedDirectory() }
      try await SDKProbe.shared.waitForStart()
      try require(await f.installer.installedDirectory() == nil, "availability must not wait for recovery")
      do {
        _ = try await f.installer.install(fromArchive: f.archive) { _ in }
        throw RegressionFailure.assertion("install must be busy while recovery runs")
      } catch OrukeetModelStore.StoreError.busy {}
      await SDKProbe.shared.release()
      let installed = await recovery.value
      try require(installed != nil, "recovery must publish a model")
      try require(await SDKProbe.shared.starts == 1, "only one recovery is admitted")
      checks.append("nonblocking availability and install admission during OS recovery")
    }

    do {
      let f = try Fixture()
      defer { f.cleanup() }
      await SDKProbe.shared.configure(.recover)
      await f.installer.removeUnusableCaches()
      let children = try FileManager.default.contentsOfDirectory(atPath: f.installer.modelsRoot.path)
      try require(children == ["current"], "successful recovery must prune only obsolete siblings")
      try require(FileManager.default.fileExists(atPath: f.installer.modelsRoot
        .appendingPathComponent("current/orukeet-source.zip").path), "keep retained source")
      checks.append("successful recovery prunes obsolete cache and interrupted work")
    }

    do {
      let f = try Fixture()
      defer { f.cleanup() }
      await SDKProbe.shared.configure(.failedRecovery)
      await f.installer.removeUnusableCaches()
      try require(FileManager.default.fileExists(atPath: f.old.path), "failed recovery must preserve prior source")
      try require(FileManager.default.fileExists(atPath: f.abandoned.path), "failed recovery must not prune")
      checks.append("failed recovery preserves source and avoids cleanup")
    }

    do {
      let f = try Fixture()
      defer { f.cleanup() }
      await SDKProbe.shared.configure(.recover, blocked: true)
      let recovery = Task { await f.installer.installedDirectory() }
      try await SDKProbe.shared.waitForStart()
      recovery.cancel()
      try require(await recovery.value == nil, "caller cancellation must cancel OS recovery")
      try require(await SDKProbe.shared.cancellations == 1, "cancellation must reach the store task")
      try require(FileManager.default.fileExists(atPath: f.old.path), "cancelled lookup preserves source")
      await SDKProbe.shared.configure(.recover)
      try require(await f.installer.installedDirectory() != nil, "cancelled recovery can retry")
      checks.append("lookup cancellation propagates and recovery retries")
    }

    do {
      let f = try Fixture()
      defer { f.cleanup() }
      await SDKProbe.shared.configure(.recover, blocked: true, holdCancellation: true)
      let recovery = Task { await f.installer.installedDirectory() }
      try await SDKProbe.shared.waitForStart()
      let deletion = Task { try await f.installer.deleteModelsAndStaging() }
      try await SDKProbe.shared.waitForCancellation()
      let repeatedDeletion = Task { try await f.installer.deleteModelsAndStaging() }
      try require(await f.installer.installedDirectory() == nil, "lookup must not restart during deletion")
      do {
        _ = try await f.installer.install(fromArchive: f.archive) { _ in }
        throw RegressionFailure.assertion("install must be busy while deletion joins recovery")
      } catch OrukeetModelStore.StoreError.busy {}
      try require(FileManager.default.fileExists(atPath: f.old.path), "delete must await recovery unwind")
      await SDKProbe.shared.releaseCancellation()
      try await deletion.value
      try await repeatedDeletion.value
      _ = await recovery.value
      try require(!FileManager.default.fileExists(atPath: f.installer.modelsRoot.path), "delete all compiled caches")
      try require(!FileManager.default.fileExists(atPath: f.installer.stagingDirectory.path), "delete JS partial downloads")
      try require(FileManager.default.fileExists(atPath: f.archive.path), "preserve caller-owned archive")
      try require(try f.home.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true,
                  "keep backup-excluded home for later downloads")
      await SDKProbe.shared.configure(.normal)
      _ = try await f.installer.install(fromArchive: f.archive) { _ in }
      checks.append("deletion joins recovery, blocks new work, removes caches/staging and permits reinstall")
    }

    do {
      let f = try Fixture()
      defer { f.cleanup() }
      await SDKProbe.shared.configure(.blockedInstall, blocked: true)
      let installation = Task { try await f.installer.install(fromArchive: f.archive) { _ in } }
      try await SDKProbe.shared.waitForStart()
      installation.cancel()
      do {
        _ = try await installation.value
        throw RegressionFailure.assertion("cancelled installation must throw")
      } catch is CancellationError {}
      try require(await SDKProbe.shared.cancellations == 1, "install parent cancellation reaches store")
      try require(FileManager.default.fileExists(atPath: f.archive.path), "cancelled install preserves archive")
      try require(FileManager.default.fileExists(atPath: f.old.path), "cancelled install does not prune")
      checks.append("install caller cancellation propagates without pruning or deleting input")
    }

    do {
      let f = try Fixture()
      defer { f.cleanup() }
      await SDKProbe.shared.configure(.invalidCurrent)
      let installed = try await f.installer.install(fromArchive: f.archive) { _ in }
      try require(installed.lastPathComponent == "current", "invalid current install replaced once")
      try require(!FileManager.default.fileExists(atPath: f.old.path), "invalid install root replaced")
      try require(FileManager.default.fileExists(atPath: f.archive.path), "replacement preserves caller archive")
      checks.append("invalid installation replacement completes in one pass")
    }

    let report: [String: Any] = ["passed": true, "scenario_count": checks.count, "scenarios": checks,
      "scope": "Actual OpenWhispr installer actor with a controlled SDK test double; no model inference"]
    print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
  }
}

import Foundation

// Only the SDK boundary is replaced. The harness compiles the actual application
// OrukeetInstaller.swift so actor admission/cancellation/deletion are exercised.
public actor SDKProbe {
  public enum Mode: Sendable { case normal, recover, failedRecovery, invalidCurrent, blockedInstall }
  public static let shared = SDKProbe()
  private var mode: Mode = .normal
  private var blocked = false
  private var holdCancellation = false
  private var cancellationWaiters: [CheckedContinuation<Void, Never>] = []
  public private(set) var starts = 0
  public private(set) var cancellations = 0

  public func configure(_ mode: Mode, blocked: Bool = false, holdCancellation: Bool = false) {
    self.mode = mode
    self.blocked = blocked
    self.holdCancellation = holdCancellation
    starts = 0
    cancellations = 0
  }

  public func currentMode() -> Mode { mode }
  public func release() { blocked = false }
  public func releaseCancellation() {
    holdCancellation = false
    cancellationWaiters.forEach { $0.resume() }
    cancellationWaiters.removeAll()
  }

  public func enter() async throws {
    starts += 1
    do {
      while blocked { try await Task.sleep(for: .milliseconds(5)) }
      try Task.checkCancellation()
    } catch {
      cancellations += 1
      if holdCancellation {
        await withCheckedContinuation { cancellationWaiters.append($0) }
      }
      throw CancellationError()
    }
  }

  public func waitForStart() async throws {
    for _ in 0..<400 {
      if starts > 0 { return }
      try await Task.sleep(for: .milliseconds(5))
    }
    throw ProbeError.timeout
  }

  public func waitForCancellation() async throws {
    for _ in 0..<400 {
      if cancellations > 0 { return }
      try await Task.sleep(for: .milliseconds(5))
    }
    throw ProbeError.timeout
  }

  private enum ProbeError: Error { case timeout }
}

public actor OrukeetModelStore {
  public enum StoreError: Error, Equatable { case busy, invalidInstallation(String) }
  public struct State: Sendable {}
  private let root: URL
  public init(rootDirectory: URL) { root = rootDirectory }

  public func installedDirectory() async throws -> URL? {
    try Task.checkCancellation()
    let mode = await SDKProbe.shared.currentMode()
    if mode == .invalidCurrent { throw StoreError.invalidInstallation("test corruption") }
    let current = root.appendingPathComponent("current")
    if FileManager.default.fileExists(atPath: current.path) { return current }
    guard mode == .recover || mode == .failedRecovery else { return nil }
    try await SDKProbe.shared.enter()
    if mode == .failedRecovery { throw StoreError.invalidInstallation("test compiler failure") }
    return try publish()
  }

  public func install(fromArchive archive: URL,
                      progress: @escaping @Sendable (State) -> Void) async throws -> URL {
    if await SDKProbe.shared.currentMode() == .blockedInstall { try await SDKProbe.shared.enter() }
    try Task.checkCancellation()
    guard FileManager.default.fileExists(atPath: archive.path) else {
      throw StoreError.invalidInstallation("caller archive was removed")
    }
    return try publish()
  }

  private func publish() throws -> URL {
    let current = root.appendingPathComponent("current")
    try FileManager.default.createDirectory(at: current, withIntermediateDirectories: true)
    try Data("authenticated source".utf8).write(to: current.appendingPathComponent("orukeet-source.zip"))
    return current
  }
}

import Foundation

final class AttestedJob: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private var session: URLSession?
  private var attachedSocket: URLSessionWebSocketTask?

  var isCancelled: Bool {
    lock.lock(); defer { lock.unlock() }
    return cancelled
  }

  var socket: URLSessionWebSocketTask? {
    lock.lock(); defer { lock.unlock() }
    return cancelled ? nil : attachedSocket
  }

  func attach(_ session: URLSession) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if cancelled { session.invalidateAndCancel(); return false }
    self.session = session
    return true
  }

  func attach(_ socket: URLSessionWebSocketTask) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if cancelled { socket.cancel(with: .goingAway, reason: nil); return false }
    attachedSocket = socket
    return true
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let currentSession = session
    let currentSocket = attachedSocket
    session = nil
    attachedSocket = nil
    lock.unlock()
    currentSocket?.cancel(with: .goingAway, reason: nil)
    currentSession?.invalidateAndCancel()
  }
}

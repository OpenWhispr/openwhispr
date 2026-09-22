import ExpoModulesCore
import Foundation
import TinfoilAI
import BackgroundUploader

private struct AttestedRequest: Record {
  @Field var id: String = ""
  @Field var apiKey: String = ""
  @Field var path: String = ""
  @Field var body: String?
  @Field var fileUri: String?
  @Field var routeSnapshot: String?
  @Field var fileName: String = "recording.wav"
  @Field var mimeType: String = "audio/wav"
  @Field var parameters: [String: String] = [:]
}

public class TinfoilTransportModule: Module {
  private let lock = NSLock()
  private var jobs: [String: AttestedJob] = [:]

  public func definition() -> ModuleDefinition {
    Name("TinfoilTransport")
    Events("socket")
    Function("prepare") { (id: String) in _ = self.addJob(id) }
    AsyncFunction("request") { (input: AttestedRequest, promise: Promise) in
      guard let job = self.getJob(input.id) else {
        promise.reject("TINFOIL_CANCELLED", "Request cancelled."); return
      }
      Task {
        do {
          guard !job.isCancelled else { throw URLError(.cancelled) }
          guard ["/v1/models", "/v1/chat/completions", "/v1/audio/transcriptions"].contains(input.path), !input.apiKey.isEmpty else { throw URLError(.badURL) }
          if let snapshot = input.routeSnapshot, let audioUri = input.fileUri {
            try ProviderRecoveryStore.savePending(snapshotJSON: snapshot, audioUri: audioUri)
          }
          let (base, session) = try await self.verifiedSession(job: job)
          var request = URLRequest(url: base.appendingPathComponent(String(input.path.dropFirst())))
          request.timeoutInterval = 120
          request.setValue("Bearer \(input.apiKey)", forHTTPHeaderField: "Authorization")
          if let fileUri = input.fileUri {
            guard input.path == "/v1/audio/transcriptions", let fileURL = URL(string: fileUri), fileURL.isFileURL else { throw URLError(.badURL) }
            let values = try fileURL.resourceValues(forKeys: [.fileSizeKey])
            guard let size = values.fileSize, size > 0, size <= 25 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
            let boundary = "OpenWhispr-\(UUID().uuidString)"
            var body = Data()
            func append(_ value: String) { body.append(Data(value.utf8)) }
            for (name, value) in input.parameters.sorted(by: { $0.key < $1.key }) {
              guard ["model", "language"].contains(name) else { throw URLError(.badURL) }
              append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
            }
            let name = input.fileName.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
            guard !input.mimeType.contains("\r"), !input.mimeType.contains("\n") else { throw URLError(.badURL) }
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(input.mimeType)\r\n\r\n")
            body.append(try Data(contentsOf: fileURL))
            append("\r\n--\(boundary)--\r\n")
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
          } else if let body = input.body {
            request.httpMethod = "POST"
            request.httpBody = Data(body.utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
          }
          let (data, response) = try await session.data(for: request)
          guard !job.isCancelled else { throw URLError(.cancelled) }
          guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
          if (200..<300).contains(http.statusCode), let snapshot = input.routeSnapshot,
             let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
             let text = result["text"] as? String, !text.isEmpty {
            try ProviderRecoveryStore.saveResult(snapshotJSON: snapshot, text: text)
          }
          promise.resolve(["status": http.statusCode, "body": (200..<300).contains(http.statusCode) ? String(data: data, encoding: .utf8) ?? "" : ""])
        } catch {
          promise.reject("TINFOIL_REQUEST_FAILED", "Tinfoil verification or request failed. No unverified connection was used.")
        }
        self.finish(input.id, job: job)
      }
    }
    AsyncFunction("openSocket") { (id: String, apiKey: String, model: String, promise: Promise) in
      guard let job = self.getJob(id) else {
        promise.reject("TINFOIL_CANCELLED", "Request cancelled."); return
      }
      Task {
        var resolved = false
        do {
          let (base, session) = try await self.verifiedSession(job: job, id: id)
          guard !apiKey.isEmpty, var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
          components.scheme = "wss"
          components.path = "/v1/realtime"
          components.queryItems = [URLQueryItem(name: "model", value: model)]
          guard let url = components.url else { throw URLError(.badURL) }
          var request = URLRequest(url: url)
          request.timeoutInterval = 30
          request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
          let socket = session.webSocketTask(with: request)
          guard job.attach(socket) else { throw URLError(.cancelled) }
          socket.resume()
          promise.resolve(nil)
          resolved = true
          while socket.state == .running {
            let message = try await socket.receive()
            switch message {
            case .string(let text): self.socketEvent(id, type: "message", data: text)
            case .data(let bytes): if let text = String(data: bytes, encoding: .utf8) { self.socketEvent(id, type: "message", data: text) }
            @unknown default: break
            }
          }
        } catch {
          if !resolved { promise.reject("TINFOIL_SOCKET_FAILED", "Tinfoil verified connection failed.") }
          self.socketEvent(id, type: "error")
          self.socketEvent(id, type: "close")
        }
        self.finish(id, job: job)
      }
    }
    AsyncFunction("send") { (id: String, data: String, promise: Promise) in
      guard let socket = self.getJob(id)?.socket else { promise.reject("TINFOIL_SOCKET_CLOSED", "Connection closed."); return }
      socket.send(.string(data)) { error in
        if error != nil { promise.reject("TINFOIL_SEND_FAILED", "Tinfoil send failed.") }
        else { promise.resolve(nil) }
      }
    }
    Function("cancel") { (id: String) in self.getJob(id)?.cancel() }
    OnDestroy {
      self.lock.lock()
      let jobs = Array(self.jobs.values)
      self.jobs.removeAll()
      self.lock.unlock()
      jobs.forEach { $0.cancel() }
    }
  }

  private func verifiedSession(job: AttestedJob, id: String? = nil) async throws -> (URL, URLSession) {
    guard !job.isCancelled else { throw URLError(.cancelled) }
    let verifier = SecureClient()
    let truth = try await verifier.verify()
    guard !job.isCancelled else { throw URLError(.cancelled) }
    guard let rawURL = verifier.verifiedEnclaveURL,
          let base = URL(string: rawURL.hasPrefix("https://") ? rawURL : "https://\(rawURL)"),
          base.scheme == "https", let host = base.host,
          base.user == nil, base.password == nil,
          truth.tlsPublicKey.count == 64 else { throw URLError(.serverCertificateUntrusted) }
    let delegate = AttestedSessionDelegate(host: host, fingerprint: truth.tlsPublicKey) { [weak self] type, data in
      if let id { self?.socketEvent(id, type: type, data: data) }
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    guard job.attach(session) else { throw URLError(.cancelled) }
    return (base, session)
  }

  private func addJob(_ id: String) -> AttestedJob {
    lock.lock(); defer { lock.unlock() }
    jobs[id]?.cancel()
    let job = AttestedJob()
    jobs[id] = job
    return job
  }
  private func getJob(_ id: String) -> AttestedJob? { lock.lock(); defer { lock.unlock() }; return jobs[id] }
  private func finish(_ id: String, job: AttestedJob) {
    job.cancel()
    lock.lock(); defer { lock.unlock() }
    if jobs[id] === job { jobs.removeValue(forKey: id) }
  }
  private func socketEvent(_ id: String, type: String, data: String? = nil) {
    var event = ["id": id, "type": type]
    if let data { event["data"] = data }
    sendEvent("socket", event)
  }
}

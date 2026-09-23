import Foundation

struct ProviderTransportResponse {
  let status: Int
  let body: String
  let url: String
  let headers: [String: String]
}

enum ProviderTransportError: Error {
  case invalidRequest
  case invalidURL
  case cancelled
  case network
  case localNetwork
  case httpsRequired

  var code: String {
    switch self {
    case .invalidRequest: return "PROVIDER_INVALID_REQUEST"
    case .invalidURL: return "PROVIDER_INVALID_URL"
    case .cancelled: return "PROVIDER_CANCELLED"
    case .network: return "PROVIDER_NETWORK_ERROR"
    case .localNetwork: return "PROVIDER_LOCAL_NETWORK_ERROR"
    case .httpsRequired: return "PROVIDER_HTTPS_REQUIRED"
    }
  }

  var message: String {
    switch self {
    case .invalidRequest: return "Invalid provider request."
    case .invalidURL: return "Use HTTPS or a private-network HTTP endpoint."
    case .cancelled: return "Provider request cancelled."
    case .network: return "Unable to reach the provider. Check your connection and try again."
    case .localNetwork: return "Unable to reach the local server. Check Local Network permission in Settings and the server address."
    case .httpsRequired: return "iOS only allows this server over HTTPS. Use an HTTPS address."
    }
  }
}

// Ephemeral sessions keep provider credentials out of caches and cookie stores.
// Refusing redirects in the native delegate prevents URLSession from forwarding
// authentication before JavaScript can inspect the response's origin.
final class ProviderRequestTransport: NSObject, URLSessionTaskDelegate {
  private let lock = NSLock()
  private var tasks: [String: URLSessionTask] = [:]
  private var cancelledBeforeStart: Set<String> = []
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }()

  static func isAllowedURL(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(),
          !host.isEmpty, url.user == nil, url.password == nil, url.fragment == nil else { return false }
    if scheme == "https" { return true }
    return scheme == "http" && isPrivateHost(host)
  }

  private static func isPrivateHost(_ rawHost: String) -> Bool {
    let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if ["localhost", "0.0.0.0", "::1"].contains(host) || host.hasSuffix(".local") || host.hasSuffix(".ts.net") { return true }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    if labels.count == 4 {
      let octets = labels.compactMap { label -> Int? in
        guard !label.isEmpty, label.allSatisfy({ $0.isASCII && $0.isNumber }),
              label == "0" || !label.hasPrefix("0"), let value = Int(label), value <= 255 else { return nil }
        return value
      }
      if octets.count == 4 {
        return octets[0] == 127 || octets[0] == 10
          || (octets[0] == 192 && octets[1] == 168)
          || (octets[0] == 172 && (16...31).contains(octets[1]))
          || (octets[0] == 100 && (64...127).contains(octets[1]))
          || (octets[0] == 169 && octets[1] == 254)
      }
    }
    if host.contains(":") {
      return host.hasPrefix("fc") || host.hasPrefix("fd")
        || ["fe8", "fe9", "fea", "feb"].contains(where: { host.hasPrefix($0) })
    }
    return false
  }

  func request(
    requestId: String,
    url: URL,
    method: String,
    headers: [String: String],
    body: Data?,
    bodyFileURL: URL?,
    timeout: TimeInterval,
    completion: @escaping (Result<ProviderTransportResponse, ProviderTransportError>) -> Void
  ) {
    func reject(_ error: ProviderTransportError) {
      if let bodyFileURL { try? FileManager.default.removeItem(at: bodyFileURL) }
      completion(.failure(error))
    }
    guard Self.isAllowedURL(url) else { reject(.invalidURL); return }
    guard !requestId.isEmpty, ["GET", "POST"].contains(method), timeout.isFinite, timeout > 0 else {
      reject(.invalidRequest); return
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = min(timeout, 300)
    request.httpBody = body
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    let completed: (Data?, URLResponse?, Error?) -> Void = { [weak self] data, response, error in
      if let bodyFileURL { try? FileManager.default.removeItem(at: bodyFileURL) }
      self?.lock.lock()
      self?.tasks.removeValue(forKey: requestId)
      self?.lock.unlock()
      if let error = error as NSError? {
        if error.code == NSURLErrorCancelled { completion(.failure(.cancelled)) }
        // App Transport Security refuses plain HTTP to hosts it does not treat as local.
        else if error.code == NSURLErrorAppTransportSecurityRequiresSecureConnection { completion(.failure(.httpsRequired)) }
        else if Self.isPrivateHost(url.host?.lowercased() ?? "") { completion(.failure(.localNetwork)) }
        else { completion(.failure(.network)) }
        return
      }
      guard let response = response as? HTTPURLResponse else { completion(.failure(.network)); return }
      let text = (200..<300).contains(response.statusCode) ? String(data: data ?? Data(), encoding: .utf8) ?? "" : ""
      var safeHeaders: [String: String] = [:]
      for name in ["Content-Type", "Retry-After"] {
        if let value = response.value(forHTTPHeaderField: name) { safeHeaders[name.lowercased()] = value }
      }
      completion(.success(ProviderTransportResponse(status: response.statusCode, body: text, url: url.absoluteString, headers: safeHeaders)))
    }
    lock.lock()
    if cancelledBeforeStart.remove(requestId) != nil {
      lock.unlock()
      reject(.cancelled)
      return
    }
    guard tasks[requestId] == nil else {
      lock.unlock()
      reject(.invalidRequest)
      return
    }
    let task: URLSessionTask
    if let bodyFileURL { task = session.uploadTask(with: request, fromFile: bodyFileURL, completionHandler: completed) }
    else { task = session.dataTask(with: request, completionHandler: completed) }
    tasks[requestId] = task
    lock.unlock()
    task.resume()
  }

  func cancel(requestId: String) {
    lock.lock()
    let task = tasks[requestId]
    if task == nil { cancelledBeforeStart.insert(requestId) }
    lock.unlock()
    task?.cancel()
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

import Foundation

struct ProviderJobMetadata: Codable {
  struct Route: Codable {
    var mode: String
    var scope: String
    var providerId: String?
    var modelId: String?
    var endpoint: String?
    var credentialRef: String?

    mutating func validate() -> Bool {
      guard ["dictation", "upload", "meeting", "cleanup", "notes", "agent"].contains(scope) else { return false }
      if ["local", "openwhispr"].contains(mode) {
        providerId = nil; modelId = nil; endpoint = nil; credentialRef = nil
        return true
      }
      guard mode == "providers", let providerId, !providerId.isEmpty,
            let modelId, !modelId.isEmpty, modelId.count <= 512,
            let endpoint, endpoint.count <= 2048, let url = URL(string: endpoint),
            ProviderRequestTransport.isAllowedURL(url), url.query == nil else { return false }
      if let credentialRef,
         credentialRef.range(of: "^(provider\\.[a-z][a-z0-9-]*|custom\\.[a-f0-9]{64})$", options: .regularExpression) == nil { return false }
      return true
    }
  }

  struct JobRoute: Codable {
    var provider: String
    var inferenceRoute: Route?
    var cleanupRoute: Route?
    var cleanupUnavailable: String?
    var agentRoute: Route?
    var agentUnavailable: String?
  }

  let version: Int
  let jobId: String
  let requestContext: String?
  var route: JobRoute

  static func decode(_ value: String?) -> ProviderJobMetadata? {
    guard let value, let data = value.data(using: .utf8),
          var metadata = try? JSONDecoder().decode(ProviderJobMetadata.self, from: data),
          metadata.version == 1, !metadata.jobId.isEmpty, metadata.jobId.count <= 128,
          ["cloud", "local", "byok"].contains(metadata.route.provider) else { return nil }
    if let context = metadata.requestContext, !["keyboard", "recording", "file"].contains(context) { return nil }
    if metadata.route.provider == "byok" {
      guard metadata.route.inferenceRoute?.mode == "providers", metadata.route.inferenceRoute?.validate() == true else { return nil }
    } else { metadata.route.inferenceRoute = nil }
    if metadata.route.cleanupRoute != nil && metadata.route.cleanupRoute?.validate() != true { return nil }
    if metadata.route.agentRoute != nil && metadata.route.agentRoute?.validate() != true { return nil }
    // Recovery needs the refusal, not arbitrary error strings that might contain
    // provider response data. Codable also drops unknown fields such as API keys.
    if metadata.route.cleanupUnavailable != nil { metadata.route.cleanupUnavailable = "Cleanup was unavailable when this recording started." }
    if metadata.route.agentUnavailable != nil { metadata.route.agentUnavailable = "Agent processing was unavailable when this recording started." }
    return metadata
  }

  func matchesDestination(_ url: URL) -> Bool {
    guard let endpoint = route.inferenceRoute?.endpoint, let routeURL = URL(string: endpoint) else { return false }
    return url.scheme?.lowercased() == routeURL.scheme?.lowercased()
      && url.host?.lowercased() == routeURL.host?.lowercased()
      && (url.port ?? (url.scheme == "https" ? 443 : 80)) == (routeURL.port ?? (routeURL.scheme == "https" ? 443 : 80))
  }

  func transcript(from body: String) -> String? {
    guard let data = body.data(using: .utf8),
          let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let trimmed = (payload["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else { return nil }
    return trimmed
  }

  func resultEnvelope(text: String) -> String? {
    guard let routeData = try? JSONEncoder().encode(route),
          let routeObject = try? JSONSerialization.jsonObject(with: routeData) else { return nil }
    var envelope: [String: Any] = ["version": version, "jobId": jobId, "text": text, "route": routeObject]
    if let requestContext { envelope["requestContext"] = requestContext }
    guard let resultData = try? JSONSerialization.data(withJSONObject: envelope) else { return nil }
    return String(data: resultData, encoding: .utf8)
  }

  var encoded: String? {
    guard let data = try? JSONEncoder().encode(self) else { return nil }
    return String(data: data, encoding: .utf8)
  }
}

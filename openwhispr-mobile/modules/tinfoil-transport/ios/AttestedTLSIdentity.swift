import Foundation
import Security
import CryptoKit

// The verifier attests SHA-256 of DER SubjectPublicKeyInfo, not the certificate
// or Apple's X9.63 key representation. Unsupported key algorithms fail closed.
enum AttestedTLSIdentity {
  enum IdentityError: Error { case unsupportedKey }

  static func fingerprint(_ key: SecKey) throws -> String {
    guard let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
          attributes[kSecAttrKeyType] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
          let size = attributes[kSecAttrKeySizeInBits] as? Int,
          let raw = SecKeyCopyExternalRepresentation(key, nil) as Data? else {
      throw IdentityError.unsupportedKey
    }
    let spki: Data
    switch size {
    case 256: spki = try P256.Signing.PublicKey(x963Representation: raw).derRepresentation
    case 384: spki = try P384.Signing.PublicKey(x963Representation: raw).derRepresentation
    case 521: spki = try P521.Signing.PublicKey(x963Representation: raw).derRepresentation
    default: throw IdentityError.unsupportedKey
    }
    return SHA256.hash(data: spki).map { String(format: "%02x", $0) }.joined()
  }

  static func matches(key: SecKey, fingerprint expected: String) -> Bool {
    guard expected.count == 64, let actual = try? fingerprint(key) else { return false }
    return actual == expected.lowercased()
  }
}

final class AttestedSessionDelegate: NSObject, URLSessionTaskDelegate, URLSessionWebSocketDelegate, @unchecked Sendable {
  private let host: String
  private let fingerprint: String
  private let event: @Sendable (String, String?) -> Void

  init(host: String, fingerprint: String, event: @escaping @Sendable (String, String?) -> Void = { _, _ in }) {
    self.host = host
    self.fingerprint = fingerprint
    self.event = event
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          challenge.protectionSpace.host == host,
          let trust = challenge.protectionSpace.serverTrust,
          SecTrustEvaluateWithError(trust, nil),
          let key = SecTrustCopyKey(trust),
          AttestedTLSIdentity.matches(key: key, fingerprint: fingerprint) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) { event("open", nil) }
  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) { event("close", String(closeCode.rawValue)) }
}

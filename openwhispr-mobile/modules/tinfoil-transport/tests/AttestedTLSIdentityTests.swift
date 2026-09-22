import Foundation
import Security
import CryptoKit

@main
struct AttestedTLSIdentityTests {
  static func main() throws {
    let key = P256.Signing.PrivateKey().publicKey
    let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPublic, kSecAttrKeySizeInBits: 256]
    let securityKey = SecKeyCreateWithData(key.x963Representation as CFData, attributes as CFDictionary, nil)!
    let expected = SHA256.hash(data: key.derRepresentation).map { String(format: "%02x", $0) }.joined()
    let actual = try AttestedTLSIdentity.fingerprint(securityKey)
    precondition(actual == expected)
    precondition(AttestedTLSIdentity.matches(key: securityKey, fingerprint: expected))
    precondition(!AttestedTLSIdentity.matches(key: securityKey, fingerprint: String(repeating: "0", count: 64)))
    precondition(!AttestedTLSIdentity.matches(key: securityKey, fingerprint: ""))
    let cancelledJob = AttestedJob()
    cancelledJob.cancel()
    precondition(cancelledJob.isCancelled)
    precondition(!cancelledJob.attach(URLSession(configuration: .ephemeral)))
    let session = URLSession(configuration: .ephemeral)
    let socket = session.webSocketTask(with: URL(string: "wss://example.invalid")!)
    precondition(!cancelledJob.attach(socket))
    precondition(cancelledJob.socket == nil)
    let activeJob = AttestedJob()
    precondition(activeJob.attach(session))
    precondition(activeJob.attach(session.webSocketTask(with: URL(string: "wss://example.invalid")!)))
    precondition(activeJob.socket != nil)
    activeJob.cancel()
    precondition(activeJob.socket == nil)
    print("Attested TLS identity and cancellation tests passed")
  }
}

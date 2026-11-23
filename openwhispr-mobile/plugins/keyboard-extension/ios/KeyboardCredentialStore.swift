import Foundation
import Security

/// Reads the session the app shares with the keyboard (`setKeyboardSessionCredential` in
/// modules/app-group-storage, written by src/lib/keyboardCredentialSync.ts as
/// `{"userId": …, "cookie": …}`). The item lives in the App Group's access group, which both
/// targets already hold, so no Keychain entitlement is needed.
enum KeyboardCredentialStore {
  // Must match AppGroupStorageModule.keyboardSession* (a Jest test compares them).
  static let service = "com.openwhispr.keyboard-session"
  static let account = "cookie"

  /// The cookie, only when the item belongs to `userId` (the snapshot's account): after an
  /// account switch the app may not have managed to rewrite it yet.
  static func readCookie(accessGroup: String, userId: String) -> String? {
    cookie(from: read(accessGroup: accessGroup), for: userId)
  }

  static func cookie(from raw: String?, for userId: String) -> String? {
    guard let data = raw?.data(using: .utf8),
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      object["userId"] as? String == userId,
      let cookie = object["cookie"] as? String, !cookie.isEmpty
    else { return nil }
    return cookie
  }

  static func read(accessGroup: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: accessGroup,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
      let data = found as? Data,
      let cookie = String(data: data, encoding: .utf8),
      !cookie.isEmpty
    else { return nil }
    return cookie
  }
}

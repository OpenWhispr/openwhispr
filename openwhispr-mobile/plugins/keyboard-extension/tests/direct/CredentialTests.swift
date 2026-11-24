import Foundation

extension DirectDictationTests {
  static func testCredential() {
    let raw = #"{"userId":"u1","cookie":"better-auth.session_token=abc"}"#
    expect(KeyboardCredentialStore.cookie(from: raw, for: "u1"), "better-auth.session_token=abc", "credential: own account")
    expect(KeyboardCredentialStore.cookie(from: raw, for: "u2") == nil, true, "credential: another account")
    expect(KeyboardCredentialStore.cookie(from: "better-auth.session_token=abc", for: "u1") == nil, true,
           "credential: a bare cookie names no account")
    expect(KeyboardCredentialStore.cookie(from: #"{"userId":"u1","cookie":""}"#, for: "u1") == nil, true,
           "credential: empty cookie")
    expect(KeyboardCredentialStore.cookie(from: nil, for: "u1") == nil, true, "credential: no item")
  }
}

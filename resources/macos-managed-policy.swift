import Foundation
import CoreFoundation

let domain = "com.gizmolabs.openwhispr" as CFString
let keys = ["Policy", "RequireSignIn", "AuditLogPath", "WipeLocalDataOnLaunch", "DisableMeetingRecording"]
CFPreferencesAppSynchronize(domain)
var values: [String: Any] = [:]
for key in keys where CFPreferencesAppValueIsForced(key as CFString, domain) {
    values[key] = CFPreferencesCopyAppValue(key as CFString, domain) ?? NSNull()
}
do {
    let data = try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data("Managed preferences could not be read.\n".utf8))
    exit(1)
}

import Cocoa
import ApplicationServices

// Exit 2 means unsupported before mutation. Exit 3 means uncertain, never retry.
let data = FileHandle.standardInput.readDataToEndOfFile()
guard data.count <= 1_048_576, let text = String(data: data, encoding: .utf8), !text.isEmpty,
      AXIsProcessTrusted() else { exit(2) }
let system = AXUIElementCreateSystemWide()
var focused: CFTypeRef?
guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
      let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { exit(2) }
let element = focused as! AXUIElement
var role: CFTypeRef?
var subrole: CFTypeRef?
_ = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
_ = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
guard [kAXTextFieldRole, kAXTextAreaRole].contains(role as? String ?? ""),
      subrole as? String != kAXSecureTextFieldSubrole else { exit(2) }
var settable: DarwinBoolean = false
guard AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success,
      settable.boolValue else { exit(2) }
let result = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString)
exit(result == .success ? 0 : 3)

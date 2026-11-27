const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test(
  "macOS pointer presses and extra modifiers interrupt standalone keyboard modifiers",
  {
    skip: process.platform !== "darwin",
  },
  (t) => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../resources/macos-globe-listener.swift"),
      "utf8"
    );
    const mouseStart = source.indexOf("func mouseButtonName(");
    const mouseEnd = source.indexOf("let mouseEventMask", mouseStart);
    const modifierDefinitionsStart = source.indexOf("let rightModifiers:");
    const modifierDefinitionsEnd = source.indexOf(
      "func mouseButtonName(",
      modifierDefinitionsStart
    );
    const modifierMonitorStart = source.indexOf(
      "guard let monitor = NSEvent.addGlobalMonitorForEvents"
    );
    const modifierMonitorEnd = source.indexOf("let namedCompoundKeys:", modifierMonitorStart);
    const { getMacCompoundTerminalKey } = require("../../src/helpers/globeKeyManager");
    const namedBindings = [
      ["Control+Space", "kVK_Space"],
      ["Cmd+Enter", "kVK_Return"],
      ["Cmd+Escape", "kVK_Escape"],
      ["Control+Left", "kVK_LeftArrow"],
      ["Control+F20", "kVK_F20"],
      ["Control+NumAdd", "kVK_ANSI_KeypadPlus"],
    ].map(([binding, keyCode]) => {
      const terminal = getMacCompoundTerminalKey(binding);
      assert.ok(terminal, binding);
      return `(${JSON.stringify(terminal)}, ${keyCode})`;
    });
    assert.equal(getMacCompoundTerminalKey("Control+F21"), null);
    assert.equal(getMacCompoundTerminalKey("Control+MediaNextTrack"), null);
    const monitorStart = source.indexOf("func interruptStandaloneModifiers()");
    const monitorEnd = source.indexOf("func shutdownListener()", monitorStart);
    assert.ok(modifierDefinitionsStart >= 0 && modifierDefinitionsEnd > modifierDefinitionsStart);
    assert.ok(modifierMonitorStart >= 0 && modifierMonitorEnd > modifierMonitorStart);
    assert.ok(mouseStart >= 0 && mouseEnd > mouseStart);
    assert.ok(monitorStart >= 0 && monitorEnd > monitorStart);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-globe-pointer-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const harness = path.join(directory, "main.swift");
    const binary = path.join(directory, "globe-pointer-test");
    fs.writeFileSync(
      harness,
      `
import Carbon
import Cocoa
import IOKit.hidsystem

var fnIsDown = false
var fnInterrupted = false
var fnTapInterrupted = false
var lastModifierFlags: NSEvent.ModifierFlags = []
var uninterruptedRightModifiers = Set<String>()
var watchedCompoundKeys = Set<String>()
var compoundKeysDown: [UInt16: Set<String>] = [:]
var suppressedMouseButtons: Set<String> = ["MouseButton4"]
var messages: [String] = []
var subscribedEvents: NSEvent.EventTypeMask = []
var receiveEvent: ((NSEvent) -> Void)?
var receiveModifierEvent: ((NSEvent) -> Void)?

func emit(_ message: String) {
    messages.append(message)
}

func captureMonitor(matching mask: NSEvent.EventTypeMask, handler: @escaping (NSEvent) -> Void) -> NSObject? {
    if mask == .flagsChanged {
        receiveModifierEvent = handler
    } else {
        subscribedEvents = mask
        receiveEvent = handler
    }
    return NSObject()
}

enum GlobeSystemAction {
    static func restore() {}
}

func emitWarning(_ message: String) {
    fputs(message, stderr)
}

${source.slice(modifierDefinitionsStart, modifierDefinitionsEnd)}
${source.slice(modifierMonitorStart, modifierMonitorEnd).replace("NSEvent.addGlobalMonitorForEvents", "captureMonitor")}

${source.slice(mouseStart, mouseEnd)}
${source.slice(modifierMonitorEnd, monitorStart)}
${source.slice(monitorStart, monitorEnd).replace("NSEvent.addGlobalMonitorForEvents", "captureMonitor")}

func expect(_ condition: Bool, _ message: String) {
    if !condition {
        fputs(message + "\\n", stderr)
        exit(1)
    }
}

func deliver(_ type: NSEvent.EventType) {
    let mask = NSEvent.EventTypeMask(rawValue: 1 << type.rawValue)
    guard subscribedEvents.contains(mask) else { return }
    let event = NSEvent.mouseEvent(
        with: type, location: .zero, modifierFlags: .option, timestamp: 0,
        windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1
    )!
    receiveEvent?(event)
}

for type: NSEvent.EventType in [.leftMouseDown, .rightMouseDown, .otherMouseDown] {
    uninterruptedRightModifiers = ["RightOption"]
    messages = []
    deliver(type)
    deliver(type)
    expect(messages == ["RIGHT_MOD_INTERRUPTED:RightOption"], "Expected one right modifier interruption for pointer down " + String(describing: type))
    expect(!fnInterrupted, "Pointer use should not change legacy Globe hold")
}

fnIsDown = true
for type: NSEvent.EventType in [.leftMouseDown, .rightMouseDown, .otherMouseDown] {
    fnTapInterrupted = false
    messages = []
    deliver(type)
    deliver(type)
    expect(messages == ["FN_TAP_INTERRUPTED"], "Expected one Globe pointer interruption for " + String(describing: type))
    expect(!fnInterrupted, "Globe pointer use should not consume the keyboard interruption")
}
interruptStandaloneModifiers()
expect(messages == ["FN_TAP_INTERRUPTED", "FN_INTERRUPTED"], "A keyboard event after a click must still interrupt Fn")

fnTapInterrupted = false
let sideButton = CGEvent(mouseEventSource: nil, mouseType: .otherMouseDown, mouseCursorPosition: .zero, mouseButton: .center)!
sideButton.setIntegerValueField(.mouseEventButtonNumber, value: 3)
uninterruptedRightModifiers = ["RightOption"]
messages = []
expect(emitMouseEvent(.otherMouseDown, sideButton), "Configured side-button down should still be suppressed")
expect(emitMouseEvent(.otherMouseUp, sideButton), "Configured side-button up should still be suppressed")
expect(messages == ["FN_TAP_INTERRUPTED", "RIGHT_MOD_INTERRUPTED:RightOption", "MOUSE_BUTTON_DOWN:MouseButton4", "MOUSE_BUTTON_UP:MouseButton4"], "Suppressed click must interrupt before the side-button binding and preserve its down/up payloads")

fnTapInterrupted = false
sideButton.setIntegerValueField(.mouseEventButtonNumber, value: 4)
uninterruptedRightModifiers = ["RightOption"]
messages = []
expect(!emitMouseEvent(.otherMouseDown, sideButton), "Unconfigured side-button down should reach AppKit")
expect(!uninterruptedRightModifiers.isEmpty, "Unconfigured side-button interruption should be handled by the AppKit monitor only")
deliver(.otherMouseDown)
expect(messages == ["MOUSE_BUTTON_DOWN:MouseButton5", "FN_TAP_INTERRUPTED", "RIGHT_MOD_INTERRUPTED:RightOption"], "Unconfigured side buttons should still interrupt once")

func deliverModifier(_ keyCode: UInt16, _ flags: NSEvent.ModifierFlags, deviceBits: UInt64 = 0) {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)!
    event.type = .flagsChanged
    event.flags = CGEventFlags(rawValue: UInt64(flags.rawValue) | deviceBits)
    receiveModifierEvent?(NSEvent(cgEvent: event)!)
}

fnIsDown = false
for _ in 0..<2 {
    messages = []
    deliverModifier(61, [.shift, .option])
    deliverModifier(61, .shift)
    expect(messages == ["RIGHT_MOD_DOWN:RightOption", "RIGHT_MOD_INTERRUPTED:RightOption", "RIGHT_MOD_UP:RightOption", "MODIFIER_UP:option"], "A held Shift must interrupt every Right Option tap")
}
deliverModifier(56, [])
messages = []
deliverModifier(61, .option)
deliverModifier(56, [.option, .shift])
deliverModifier(56, .option)
deliverModifier(61, [])
expect(messages == ["RIGHT_MOD_DOWN:RightOption", "RIGHT_MOD_INTERRUPTED:RightOption", "MODIFIER_UP:shift", "RIGHT_MOD_UP:RightOption", "MODIFIER_UP:option"], "A modifier pressed mid-gesture must interrupt the tap once")

messages = []
deliverModifier(58, .option, deviceBits: 0x20)
deliverModifier(61, .option, deviceBits: 0x60)
deliverModifier(61, .option, deviceBits: 0x20)
expect(messages == ["RIGHT_MOD_DOWN:RightOption", "RIGHT_MOD_INTERRUPTED:RightOption", "RIGHT_MOD_UP:RightOption"], "Left Option must disqualify Right Option, and releasing Right Option must still emit up")
deliverModifier(58, [])

deliverModifier(56, .shift)
for _ in 0..<2 {
    messages = []
    deliverModifier(63, [.shift, .function])
    deliverModifier(63, .shift)
    expect(messages == ["FN_DOWN", "FN_TAP_INTERRUPTED", "FN_UP"], "A held Shift must interrupt every Globe tap")
}
deliverModifier(56, [])

messages = []
deliverModifier(63, .function)
deliverModifier(56, [.function, .shift])
deliverModifier(56, .function)
deliverModifier(63, [])
expect(messages == ["FN_DOWN", "FN_TAP_INTERRUPTED", "MODIFIER_UP:shift", "FN_UP"], "A modifier pressed during Globe must interrupt the tap once")

for pointerFirst in [true, false] {
    messages = []
    deliverModifier(63, .function)
    if pointerFirst { deliver(.leftMouseDown) }
    deliverModifier(56, [.function, .shift])
    if !pointerFirst { deliver(.leftMouseDown) }
    deliverModifier(56, .function)
    deliverModifier(63, [])
    expect(messages.filter { $0.hasSuffix("_INTERRUPTED") }.count == 1, "A click and Shift must interrupt the same Globe press only once")
}

messages = []
deliverModifier(63, .function)
deliverModifier(63, [])
deliverModifier(61, .option, deviceBits: 0x40)
deliverModifier(61, [])
expect(messages == ["FN_DOWN", "FN_UP", "RIGHT_MOD_DOWN:RightOption", "RIGHT_MOD_UP:RightOption", "MODIFIER_UP:option"], "Clean standalone presses must keep their normal edges")

watchedCompoundKeys = ["space"]
deliverModifier(59, .control)
messages = []
deliverModifier(56, [.control, .shift])
deliverModifier(56, [.control, .shift])
deliverModifier(56, .control)
expect(messages == ["MODIFIER_DOWN:shift", "MODIFIER_UP:shift"], "A transient Shift press must be visible during a compound tap")

messages = []
deliverModifier(59, .shift)
expect(messages == ["MODIFIER_DOWN:shift", "MODIFIER_UP:control"], "New modifiers must be visible before the old chord can release")

messages = []
deliverModifier(63, [.shift, .function])
deliverModifier(63, .shift)
expect(messages.filter { $0.hasPrefix("MODIFIER_") } == ["MODIFIER_DOWN:fn"], "Fn must qualify as an added modifier without duplicating its existing up protocol")

let namedBindings: [(String, Int)] = [${namedBindings.join(", ")}]
for (terminal, keyCode) in namedBindings {
    watchedCompoundKeys = [terminal]
    messages = []
    let release = CGEvent(keyboardEventSource: nil, virtualKey: UInt16(keyCode), keyDown: false)!
    receiveEvent?(NSEvent(cgEvent: release)!)
    expect(messages == ["COMPOUND_KEY_UP:" + terminal], "Expected native terminal agreement for " + terminal)
}
`
    );
    const compiled = spawnSync(
      "xcrun",
      ["swiftc", harness, "-module-cache-path", path.join(directory, "cache"), "-o", binary],
      { encoding: "utf8", timeout: 120000 }
    );
    assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
);

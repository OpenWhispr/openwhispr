const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test(
  "macOS shortcuts follow the active layout and fall back only without layout data",
  {
    skip: process.platform !== "darwin",
  },
  (t) => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../resources/macos-fast-paste.swift"),
      "utf8"
    );
    // Compile the real resolver without the permission check or event posting.
    const start = source.indexOf("let commandModifierState");
    const end = source.indexOf("// Do not post", start);
    assert.ok(start >= 0 && end > start);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-paste-layout-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const harness = path.join(directory, "main.swift");
    const binary = path.join(directory, "layout-test");
    fs.writeFileSync(
      harness,
      `
import Cocoa
import Carbon.HIToolbox

var currentSource: TISInputSource?
var asciiSource: TISInputSource?

// Stub source selection so tests never switch the user's input source.
func TISCopyCurrentKeyboardLayoutInputSource() -> Unmanaged<TISInputSource>? {
    currentSource.map { Unmanaged.passRetained($0) }
}
func TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> Unmanaged<TISInputSource>? {
    asciiSource.map { Unmanaged.passRetained($0) }
}

${source.slice(start, end)}

func source(named identifier: String) -> TISInputSource {
    let filter = [kTISPropertyInputSourceID as String: identifier] as CFDictionary
    let sources = TISCreateInputSourceList(filter, true).takeRetainedValue() as! [TISInputSource]
    guard let source = sources.first else { fatalError("Missing layout: " + identifier) }
    return source
}

let dvorak = source(named: "com.apple.keylayout.Dvorak")
let scenarios: [(String, String?, CGKeyCode, CGKeyCode)] = [
    ("Russian after Dvorak", "com.apple.keylayout.Russian", 8, 9),
    ("Dvorak", "com.apple.keylayout.Dvorak", 34, 47),
    ("Dvorak QWERTY Command", "com.apple.keylayout.DVORAK-QWERTYCMD", 8, 9),
    ("US", "com.apple.keylayout.US", 8, 9),
    ("Colemak", "com.apple.keylayout.Colemak", 8, 9),
    ("French", "com.apple.keylayout.French", 8, 9),
    ("German", "com.apple.keylayout.German", 8, 9),
    ("missing current source", nil, 34, 47)
]
for (name, identifier, copyKey, pasteKey) in scenarios {
    currentSource = identifier.map { source(named: $0) }
    asciiSource = dvorak
    let actualCopy = lookupVirtualKey(for: "c")
    let actualPaste = lookupVirtualKey(for: "v")
    guard actualCopy == copyKey && actualPaste == pasteKey else {
        fputs("Wrong shortcuts for " + name + ": " + String(describing: actualCopy) + ", " + String(describing: actualPaste) + "\\n", stderr)
        exit(1)
    }
}
let inputModes = TISCreateInputSourceList(
    [kTISPropertyInputSourceType as String: kTISTypeKeyboardInputMode] as CFDictionary,
    true
).takeRetainedValue() as! [TISInputSource]
guard let inputMode = inputModes.first(where: {
    TISGetInputSourceProperty($0, kTISPropertyUnicodeKeyLayoutData) == nil
}) else { fatalError("Missing input mode without layout data") }
currentSource = inputMode
asciiSource = dvorak
guard lookupVirtualKey(for: "c") == 34 && lookupVirtualKey(for: "v") == 47 else {
    fputs("Input method did not fall back to Dvorak\\n", stderr)
    exit(1)
}
currentSource = nil
asciiSource = nil
guard lookupVirtualKey(for: "v") == nil else { exit(1) }
// A present layout without the shortcut must fail safely, not use another layout.
currentSource = source(named: "com.apple.keylayout.Turkmen")
asciiSource = dvorak
guard lookupVirtualKey(for: "c") == nil && lookupVirtualKey(for: "v") == nil else { exit(1) }
print("layout scenarios passed")
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
    assert.match(result.stdout, /layout scenarios passed/);
  }
);

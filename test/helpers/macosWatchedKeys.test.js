const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { supportsMacKeyWatch } = require("../../src/helpers/macKeyNames");

const source = fs.readFileSync(
  path.join(__dirname, "../../resources/macos-globe-listener.swift"),
  "utf8"
);
function productionBlock(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`);
  assert.ok(start >= 0 && end > start, `${name} must be a marked production block`);
  return source.slice(start, end);
}

let runSwift;
let directory;
test.before(() => {
  if (process.platform !== "darwin") return;
  assert.equal(spawnSync("swiftc", ["--version"]).status, 0, "native tests require swiftc");
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "macos-watched-keys-"));
  const swift = path.join(directory, "main.swift");
  const binary = path.join(directory, "watched-keys");
  fs.writeFileSync(
    swift,
    `import Cocoa
${productionBlock("watched-key-map")}
var watchedKeyCodes: [Int64: String] = [:]
var emitted: [String] = []
var tapUpdates = 0
func emit(_ message: String) { emitted.append(message) }
func updateKeyboardTap() { tapUpdates += 1 }
${productionBlock("watched-key-routing")}
let input = FileHandle.standardInput.readDataToEndOfFile()
let request = try JSONSerialization.jsonObject(with: input) as! [String: Any]
var result: Any
if let names = request["names"] as? [String] {
    result = Dictionary(uniqueKeysWithValues: names.map { ($0, keyCodes(forKeyName: $0)) })
} else {
    var observations: [[String: Any]] = []
    for step in request["steps"] as! [[String: Any]] {
        if let names = step["watch"] as? [String] {
            watchedKeyCodes = [:]
            for name in names {
                for code in keyCodes(forKeyName: name) { watchedKeyCodes[code] = name }
            }
        }
        var consumed = false
        if let code = step["code"] as? Int64 {
            let type: CGEventType = (step["up"] as? Bool) == true ? .keyUp : .keyDown
            let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: type == .keyDown)!
            event.flags = CGEventFlags(rawValue: (step["flags"] as? UInt64) ?? 0)
            event.setIntegerValueField(.keyboardEventAutorepeat, value: (step["repeat"] as? Int64) ?? 0)
            consumed = routeWatchedKeyEvent(type: type, event: event) == nil
        }
        observations.append(["consumed": consumed, "emitted": emitted, "needsTap": needsKeyboardTap(), "tapUpdates": tapUpdates])
    }
    result = observations
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
`
  );
  const compiled = spawnSync("swiftc", [swift, "-o", binary], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(compiled.status, 0, `Swift production blocks failed to compile: ${compiled.stderr}`);
  runSwift = (request) => {
    const result = spawnSync(binary, [], { input: JSON.stringify(request), encoding: "utf8" });
    assert.equal(
      result.status,
      0,
      JSON.stringify({ error: result.error?.message, signal: result.signal, stderr: result.stderr })
    );
    return JSON.parse(result.stdout);
  };
});
test.after(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

const UNSUPPORTED = [
  "F21",
  "F22",
  "F23",
  "F24",
  "Pause",
  "Scrolllock",
  "PrintScreen",
  "Numlock",
  "MediaPlayPause",
  "MediaStop",
  "MediaNextTrack",
  "MediaPreviousTrack",
];

// Independent expected virtual keycodes from Apple's HIToolbox Events.h;
// compare numbers, not just two equally-permissive supported-name lists.
const EXPECTED = {
  A: [0],
  S: [1],
  D: [2],
  F: [3],
  H: [4],
  G: [5],
  Z: [6],
  X: [7],
  C: [8],
  V: [9],
  B: [11],
  Q: [12],
  W: [13],
  E: [14],
  R: [15],
  Y: [16],
  T: [17],
  1: [18],
  2: [19],
  3: [20],
  4: [21],
  6: [22],
  5: [23],
  "=": [24],
  9: [25],
  7: [26],
  "-": [27],
  8: [28],
  0: [29],
  "]": [30],
  O: [31],
  U: [32],
  "[": [33],
  I: [34],
  P: [35],
  Enter: [36, 76],
  L: [37],
  J: [38],
  "'": [39],
  K: [40],
  ";": [41],
  "\\": [42],
  ",": [43],
  "/": [44],
  N: [45],
  M: [46],
  ".": [47],
  Tab: [48],
  Space: [49],
  "`": [50],
  Backspace: [51],
  Esc: [53],
  F17: [64],
  numdec: [65],
  nummult: [67],
  numadd: [69],
  numdiv: [75],
  numsub: [78],
  F18: [79],
  F19: [80],
  num0: [82],
  num1: [83],
  num2: [84],
  num3: [85],
  num4: [86],
  num5: [87],
  num6: [88],
  num7: [89],
  F20: [90],
  num8: [91],
  num9: [92],
  F5: [96],
  F6: [97],
  F7: [98],
  F3: [99],
  F8: [100],
  F9: [101],
  F11: [103],
  F13: [105],
  F16: [106],
  F14: [107],
  F10: [109],
  F12: [111],
  F15: [113],
  Insert: [114],
  Home: [115],
  PageUp: [116],
  Delete: [117],
  F4: [118],
  End: [119],
  F2: [120],
  PageDown: [121],
  F1: [122],
  Left: [123],
  Right: [124],
  Down: [125],
  Up: [126],
};

test("every capture name has an exact macOS mapping or an explicit Tap fallback", async (t) => {
  const { CODE_TO_KEY } = await import("../../src/utils/hotkeyKeyNames.ts");
  const names = [...new Set(Object.values(CODE_TO_KEY))];
  assert.deepEqual([...Object.keys(EXPECTED), ...UNSUPPORTED].sort(), [...names].sort());
  for (const name of names) assert.equal(supportsMacKeyWatch(name), name in EXPECTED, name);
  if (!runSwift) return t.skip("Swift synthetic event tests require macOS");
  const native = runSwift({ names });
  for (const name of names) assert.deepEqual(native[name], EXPECTED[name] || [], name);
});

test("macOS aliases and case folding match the production native resolver", (t) => {
  if (!runSwift) return t.skip("Swift synthetic event tests require macOS");
  const aliases = {
    Equal: [24],
    Minus: [27],
    Return: [36, 76],
    Quote: [39],
    Semicolon: [41],
    Backslash: [42],
    Comma: [43],
    Slash: [44],
    Period: [47],
    Backquote: [50],
    Escape: [53],
    Help: [114],
    ForwardDelete: [117],
    ArrowLeft: [123],
    ArrowRight: [124],
    ArrowDown: [125],
    ArrowUp: [126],
    NUM0: [82],
    NumAdd: [69],
    f20: [90],
    c: [8],
  };
  assert.deepEqual(runSwift({ names: Object.keys(aliases) }), aliases);
  for (const alias of Object.keys(aliases)) assert.equal(supportsMacKeyWatch(alias), true, alias);
  for (const name of ["Bogus", "Command+C", "Control", "F0", "F25", "num10", "", null]) {
    assert.equal(supportsMacKeyWatch(name), false, String(name));
  }
});

const flags = { command: 1 << 20, control: 1 << 18, option: 1 << 19, shift: 1 << 17 };
for (const [modifier, flag] of Object.entries(flags)) {
  test(`plain C does not claim ${modifier}+C or its later unmodified repeat/release`, (t) => {
    if (!runSwift) return t.skip("Swift synthetic event tests require macOS");
    const observations = runSwift({
      steps: [
        { watch: ["C"], code: 8, flags: flag },
        { code: 8, flags: flag, repeat: 1 },
        { code: 8, repeat: 1 },
        { code: 8, up: true },
      ],
    });
    assert.ok(observations.every((step) => !step.consumed && step.emitted.length === 0));
  });
}

test("owned bare presses swallow repeats and keep the matching release after modifiers change", (t) => {
  if (!runSwift) return t.skip("Swift synthetic event tests require macOS");
  const observations = runSwift({
    steps: [
      { watch: ["C"], code: 8 },
      { code: 8, repeat: 1 },
      { code: 8, flags: flags.command, repeat: 1 },
      { code: 8, flags: flags.command, up: true },
      { code: 8, up: true },
    ],
  });
  assert.deepEqual(
    observations.map((step) => step.consumed),
    [true, true, true, true, false]
  );
  assert.deepEqual(observations[2].emitted, ["KEY_DOWN:C"]);
  assert.deepEqual(observations[3].emitted, ["KEY_DOWN:C", "KEY_UP:C"]);
  assert.deepEqual(observations[4].emitted, observations[3].emitted);
});

test("a config removal keeps the tap until every original owned key has released", (t) => {
  if (!runSwift) return t.skip("Swift synthetic event tests require macOS");
  const observations = runSwift({
    steps: [
      { watch: ["C", "num0"], code: 8 },
      { code: 82 },
      { watch: [] },
      { code: 8, up: true },
      { code: 82, up: true },
    ],
  });
  assert.deepEqual(
    observations.map((step) => step.needsTap),
    [true, true, true, true, false]
  );
  assert.equal(observations[3].tapUpdates, 0);
  assert.equal(observations[4].tapUpdates, 1);
  assert.deepEqual(observations[4].emitted, [
    "KEY_DOWN:C",
    "KEY_DOWN:num0",
    "KEY_UP:C",
    "KEY_UP:num0",
  ]);
});

test("changing an alias mid-press does not rename the owned release", (t) => {
  if (!runSwift) return t.skip("Swift synthetic event tests require macOS");
  const observations = runSwift({
    steps: [
      { watch: ["Delete"], code: 117 },
      { watch: ["ForwardDelete"], code: 117, up: true },
    ],
  });
  assert.deepEqual(observations.at(-1).emitted, ["KEY_DOWN:Delete", "KEY_UP:Delete"]);
});

test("Caps Lock, NumericPad and secondary Fn flags preserve ordinary key ownership", (t) => {
  if (!runSwift) return t.skip("Swift synthetic event tests require macOS");
  for (const [name, code, flag] of [
    ["C", 8, 1 << 16],
    ["num0", 82, 1 << 21],
    ["F9", 101, 1 << 23],
  ]) {
    const observations = runSwift({
      steps: [
        { watch: [name], code, flags: flag },
        { code, up: true, flags: flag },
      ],
    });
    assert.deepEqual(observations.at(-1).emitted, [`KEY_DOWN:${name}`, `KEY_UP:${name}`]);
    assert.ok(observations.every((step) => step.consumed));
  }
});

const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register: (key, callback) => {
        registered.set(key, callback);
        return true;
      },
      unregister: (key) => registered.delete(key),
      isRegistered: (key) => registered.has(key),
    },
    BrowserWindow: { getAllWindows: () => [] },
    app: { getPath: () => os.tmpdir() },
  },
};
const HotkeyManager = require("../../src/helpers/hotkeyManager");

test("the real manager owns supported macOS keys and preserves Electron Tap for unmapped names", async (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const manager = new HotkeyManager();
  registered.clear();
  let presses = 0;
  const callback = () => {
    presses += 1;
  };
  manager.slotActivationModes.voiceAgent = "push";
  for (const hotkey of ["num0", "numadd", "Delete", "Enter"]) {
    assert.equal(manager.supportsPushToTalk(hotkey, "voiceAgent"), true);
    assert.equal(
      (await manager.registerSlot("voiceAgent", hotkey, callback, { atomic: true })).success,
      true
    );
    assert.equal(manager.isMacListenerOwnedKey(hotkey, "voiceAgent"), true);
    assert.deepEqual(manager.getMacNativeListenerConfig(["voiceAgent"]).watchKeys, [hotkey]);
    assert.deepEqual([...registered.keys()], []);
  }
  for (const hotkey of ["MediaPlayPause", "F24"]) {
    manager.slotActivationModes.voiceAgent = "push";
    assert.equal(manager.supportsPushToTalk(hotkey, "voiceAgent"), false);
    const previous = manager.getSlotHotkey("voiceAgent");
    assert.equal(
      (await manager.registerSlot("voiceAgent", hotkey, callback, { atomic: true })).success,
      false
    );
    assert.equal(manager.getSlotHotkey("voiceAgent"), previous);
    assert.equal(manager.isMacListenerOwnedKey(hotkey, "voiceAgent"), false);
    manager.slotActivationModes.voiceAgent = "tap";
    assert.equal(
      (await manager.registerSlot("voiceAgent", hotkey, callback, { atomic: true })).success,
      true
    );
    assert.deepEqual(manager.getMacNativeListenerConfig(["voiceAgent"]).watchKeys, []);
    registered.get(hotkey)();
  }
  assert.equal(presses, 2);
});

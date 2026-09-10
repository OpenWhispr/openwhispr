const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Contract test over the boundary that let Windows Voice Agent Hold ship broken:
// the Settings capture screen emits key NAMES (CODE_TO_KEY), and the native
// push-to-talk listeners parse those names in C. Nothing else crosses that
// boundary, so the two sides can drift without a JavaScript test going red.
// Here we compile each listener's parser block — the real code, cut between its
// BEGIN/END markers — with the host C compiler and run every name the capture
// can produce through it, bare and with modifiers.
//
// Requires a C compiler on PATH (`cc`); CI's ubuntu runner has one. The Linux
// half also needs the kernel's <linux/input-event-codes.h>, found under
// /usr/include on Linux or via LINUX_UAPI_INCLUDE_DIR elsewhere.

const ROOT = path.join(__dirname, "../..");
const FIXTURES = path.join(__dirname, "fixtures");
const BEGIN = "// BEGIN hotkey-parser";
const END = "// END hotkey-parser";

const hasCompiler = () => spawnSync("cc", ["--version"], { encoding: "utf8" }).status === 0;

function parserBlock(file) {
  const source = fs.readFileSync(path.join(ROOT, "resources", file), "utf8");
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  assert.ok(start !== -1 && end > start, `${file} must wrap its parser in ${BEGIN} … ${END}`);
  return source.slice(start, end);
}

function compile(t, name, sourceText, includeDirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `key-vocab-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, `${name}.c`);
  const bin = path.join(dir, name);
  fs.writeFileSync(src, sourceText);
  const result = spawnSync(
    "cc",
    [
      "-std=c99",
      "-Wall",
      "-Wextra",
      "-Werror",
      ...includeDirs.map((d) => `-I${d}`),
      src,
      "-o",
      bin,
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, `compiling ${name} parser block failed:\n${result.stderr}`);
  return (hotkey) => {
    const run = spawnSync(bin, [hotkey], { encoding: "utf8" });
    const [ok, key, ctrl, alt, shift, superKey, modifiersOnly, unknown = ""] = run.stdout
      .trim()
      .split(" ");
    return {
      ok: ok === "1",
      key: Number(key),
      modifiers: {
        ctrl: ctrl === "1",
        alt: alt === "1",
        shift: shift === "1",
        super: superKey === "1",
      },
      modifiersOnly: modifiersOnly === "1",
      unknown,
    };
  };
}

// The harness prints one line: ok key ctrl alt shift super modifiersOnly [unknownToken]
const WINDOWS_HARNESS = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "windows.h"
%BLOCK%
int main(int argc, char** argv) {
    HotkeySpec spec;
    BOOL ok = argc > 1 && ParseHotkeySpec(argv[1], &spec);
    printf("%d %lu %d %d %d %d %d %s\\n", ok, (unsigned long)spec.vk, spec.requireCtrl,
           spec.requireAlt, spec.requireShift, spec.requireWin, spec.modifiersOnly,
           spec.unknownToken);
    return 0;
}
`;

const LINUX_HARNESS = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <linux/input-event-codes.h>
%BLOCK%
int main(int argc, char** argv) {
    struct hotkey_spec spec;
    int ok = argc > 1 && parse_hotkey_spec(argv[1], &spec);
    printf("%d %d %d %d %d %d %d %s\\n", ok, spec.key, spec.require_ctrl, spec.require_alt,
           spec.require_shift, spec.require_super, spec.modifiers_only, spec.unknown_token);
    return 0;
}
`;

function linuxIncludeDir() {
  const candidates = [process.env.LINUX_UAPI_INCLUDE_DIR, "/usr/include"].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, "linux/input-event-codes.h")));
}

// Every base key the capture screen can emit, deduplicated (NumpadEnter and
// Enter both map to "Enter").
async function captureKeyNames() {
  const { CODE_TO_KEY } = await import("../../src/utils/hotkeyKeyNames.ts");
  return [...new Set(Object.values(CODE_TO_KEY))];
}

// The modifier chords mapKeyboardEventToHotkey prepends on Windows/Linux, in
// the order it emits them (Control, Super, Alt, Shift).
const CHORDS = ["Control", "Control+Super", "Alt", "Shift", "Control+Alt+Shift", "Super+Alt"];

// A lone modifier is capturable on its right side only, and two-or-more
// modifiers may form a key-less combo (the Windows dictation default).
const MODIFIER_ONLY = ["Control+Super", "Control+Alt", "Alt+Super", "Control+Shift+Super"];
const RIGHT_SIDE_SINGLES = ["RightControl", "RightAlt", "RightShift", "RightSuper"];

const withPlatform = (platform, run) => {
  const had = "window" in globalThis;
  const previous = globalThis.window;
  globalThis.window = { electronAPI: { getPlatform: () => platform } };
  try {
    return run();
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
};

async function platformDefaults(platform) {
  const { getDefaultHotkey, getDefaultVoiceAgentHotkey } =
    await import("../../src/utils/hotkeys.ts");
  return withPlatform(platform, () => [getDefaultHotkey(), getDefaultVoiceAgentHotkey()]);
}

function assertVocabulary(parse, names, label) {
  for (const name of names) {
    const bare = parse(name);
    assert.ok(bare.ok, `${label}: bare "${name}" must parse (unknown token: ${bare.unknown})`);
    assert.notEqual(bare.key, 0, `${label}: bare "${name}" parsed to key code 0`);
    assert.equal(bare.modifiersOnly, false, `${label}: bare "${name}" read as modifiers-only`);

    for (const chord of CHORDS) {
      const hotkey = `${chord}+${name}`;
      const parsed = parse(hotkey);
      assert.ok(parsed.ok, `${label}: "${hotkey}" must parse (unknown token: ${parsed.unknown})`);
      assert.equal(parsed.key, bare.key, `${label}: "${hotkey}" lost its key`);
      // The load-bearing assertion: a chord with a key must never degrade to a
      // bare-modifier listener that fires on the modifiers alone.
      assert.equal(parsed.modifiersOnly, false, `${label}: "${hotkey}" degraded to modifiers-only`);
    }
  }

  for (const combo of MODIFIER_ONLY) {
    const parsed = parse(combo);
    assert.ok(parsed.ok, `${label}: modifier-only "${combo}" must parse`);
    assert.equal(parsed.modifiersOnly, true, `${label}: "${combo}" should be modifiers-only`);
    assert.equal(parsed.key, 0);
  }

  for (const single of RIGHT_SIDE_SINGLES) {
    const parsed = parse(single);
    assert.ok(parsed.ok, `${label}: "${single}" must parse`);
    assert.notEqual(parsed.key, 0, `${label}: "${single}" needs its own key code`);
    assert.equal(parsed.modifiersOnly, false);
  }

  const modifiers = parse("Control+Super+Alt+Shift+Space").modifiers;
  assert.deepEqual(modifiers, { ctrl: true, alt: true, shift: true, super: true }, label);
}

function assertLoudFailure(parse, label) {
  // An unknown key name must be a refusal, never a silent rebinding.
  for (const hotkey of ["Bogus", "Control+Bogus", "Control+Alt+NoSuchKey", "Control+Alt+"]) {
    const parsed = parse(hotkey);
    assert.equal(parsed.ok, false, `${label}: "${hotkey}" must be refused`);
    assert.equal(
      parsed.modifiersOnly,
      false,
      `${label}: "${hotkey}" silently became modifiers-only`
    );
  }
  assert.equal(parse("Control+Bogus").unknown, "Bogus", `${label}: refusal names the bad token`);
  assert.equal(parse("").ok, false, `${label}: empty hotkey is refused`);
  // Two regular keys in one chord is not a hotkey; the old parsers kept the last.
  assert.equal(parse("A+B").ok, false, `${label}: "A+B" must be refused`);
}

test("Windows key listener parses every key name the capture screen can emit", async (t) => {
  if (!hasCompiler()) return t.skip("no C compiler on PATH");
  const parse = compile(
    t,
    "windows",
    WINDOWS_HARNESS.replace("%BLOCK%", parserBlock("windows-key-listener.c")),
    [path.join(FIXTURES, "win32-stub")]
  );
  assertVocabulary(parse, await captureKeyNames(), "windows");
  assertLoudFailure(parse, "windows");

  // Numeric virtual-key codes remain accepted for direct use, but only whole
  // numbers — "00" and garbage used to parse as VK 0, the silent case. (A bare
  // "0" is the Digit0 key itself, 0x30.)
  assert.equal(parse("0x41").key, 0x41);
  assert.equal(parse("65").key, 65);
  assert.equal(parse("0").key, 0x30);
  assert.equal(parse("00").ok, false);
  assert.equal(parse("12abc").ok, false);

  for (const hotkey of await platformDefaults("win32")) {
    assert.ok(parse(hotkey).ok, `windows default "${hotkey}" must parse`);
  }
});

test("Linux key listener parses every key name the capture screen can emit", async (t) => {
  if (!hasCompiler()) return t.skip("no C compiler on PATH");
  const includeDir = linuxIncludeDir();
  if (!includeDir) {
    return t.skip("linux/input-event-codes.h not found; set LINUX_UAPI_INCLUDE_DIR to run");
  }
  const parse = compile(
    t,
    "linux",
    LINUX_HARNESS.replace("%BLOCK%", parserBlock("linux-key-listener.c")),
    [includeDir]
  );
  assertVocabulary(parse, await captureKeyNames(), "linux");
  assertLoudFailure(parse, "linux");

  for (const hotkey of await platformDefaults("linux")) {
    assert.ok(parse(hotkey).ok, `linux default "${hotkey}" must parse`);
  }
});

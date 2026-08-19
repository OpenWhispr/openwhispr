const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkKeysymAvailability,
  extractKeysym,
  parseXmodmapKeysyms,
  parseXkbcompKeysyms,
} = require("../../src/helpers/xkbKeymapCheck");

// Stock-keymap shape: F13-F24 keycodes carry XF86Launch*/XF86Tools keysyms,
// no F13-F24 keysym exists anywhere (matches the reporter's xmodmap output).
function buildStockXmodmapOutput() {
  const lines = [];
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = String.fromCharCode(65 + i);
    lines.push(`keycode ${38 + i} = ${lower} ${upper} ${lower} ${upper}`);
  }
  for (let i = 1; i <= 12; i++) {
    lines.push(`keycode ${66 + i} = F${i} F${i} F${i} F${i}`);
  }
  lines.push("keycode 65 = space space");
  lines.push("keycode 59 = comma less comma less");
  lines.push("keycode 191 = XF86Tools XF86Tools");
  lines.push("keycode 194 = XF86Launch7 NoSymbol XF86Launch7");
  lines.push("keycode 92 =");
  return lines.join("\n") + "\n";
}

const STOCK_XMODMAP = buildStockXmodmapOutput();

function buildAlphabetXkbcompKeys() {
  const lines = [];
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = String.fromCharCode(65 + i);
    lines.push(`    key <AC${String(i + 1).padStart(2, "0")}> { [ ${lower}, ${upper} ] };`);
  }
  return lines;
}

const STOCK_XKBCOMP = [
  "xkb_keymap {",
  'xkb_keycodes "evdev" {',
  "    minimum = 8;",
  "    maximum = 255;",
  "    <FK16> = 194;",
  "    alias <I194> = <FK16>;",
  "};",
  'xkb_types "complete" {',
  "    type \"ALPHABETIC\" {",
  "        map[Shift]= Level2;",
  "    };",
  "};",
  'xkb_symbols "pc+us+inet(evdev)" {',
  "    key  <ESC> {         [          Escape ] };",
  "    key <AE01> {         [               1,          exclam ] };",
  "    key <AD01> {",
  '        type= "ALPHABETIC",',
  "        symbols[Group1]= [               q,               Q ]",
  "    };",
  ...buildAlphabetXkbcompKeys(),
  "    key <FK08> {         [              F8 ] };",
  "    key <FK16> {         [     XF86Launch7 ] };",
  "    key <SPCE> {         [           space ] };",
  "};",
  'xkb_geometry "pc(pc105)" {',
  "    shape \"NORM\" { { [ 99, 99 ] } };",
  "};",
  "};",
].join("\n");

function makeExec(handlers) {
  const calls = [];
  const exec = (file, args) => {
    calls.push({ file, args });
    const handler = handlers[file];
    if (!handler) throw new Error(`spawn ${file} ENOENT`);
    return handler(args);
  };
  return { exec, calls };
}

const ENV_WITH_DISPLAY = { DISPLAY: ":0" };

test("extractKeysym strips modifier prefixes and keeps the keysym", () => {
  assert.equal(extractKeysym("<Control><Shift>F16"), "F16");
  assert.equal(extractKeysym("F8"), "F8");
  assert.equal(extractKeysym("<Alt>space"), "space");
});

test("extractKeysym returns null for empty or non-string input", () => {
  assert.equal(extractKeysym(""), null);
  assert.equal(extractKeysym(null), null);
  assert.equal(extractKeysym(undefined), null);
  assert.equal(extractKeysym(42), null);
  assert.equal(extractKeysym("<Control>"), null);
});

test("parseXmodmapKeysyms collects every level and skips NoSymbol and empty keycodes", () => {
  const keysyms = parseXmodmapKeysyms(STOCK_XMODMAP);
  assert.equal(keysyms.has("XF86Launch7"), true);
  assert.equal(keysyms.has("F8"), true);
  assert.equal(keysyms.has("less"), true);
  assert.equal(keysyms.has("NoSymbol"), false);
  assert.equal(keysyms.has("F16"), false);
  assert.equal(keysyms.has(""), false);
});

test("parseXmodmapKeysyms returns an empty set for non-string input", () => {
  assert.equal(parseXmodmapKeysyms(null).size, 0);
  assert.equal(parseXmodmapKeysyms(undefined).size, 0);
});

test("parseXkbcompKeysyms reads inline and multiline symbol lists", () => {
  const keysyms = parseXkbcompKeysyms(STOCK_XKBCOMP);
  assert.equal(keysyms.has("Escape"), true);
  assert.equal(keysyms.has("q"), true);
  assert.equal(keysyms.has("Q"), true);
  assert.equal(keysyms.has("F8"), true);
  assert.equal(keysyms.has("XF86Launch7"), true);
});

test("parseXkbcompKeysyms keeps digit keysyms from the symbols section", () => {
  assert.equal(parseXkbcompKeysyms(STOCK_XKBCOMP).has("1"), true);
});

test("parseXkbcompKeysyms ignores keycode names, the keycodes section, and geometry coordinates", () => {
  const keysyms = parseXkbcompKeysyms(STOCK_XKBCOMP);
  assert.equal(keysyms.has("FK16"), false);
  assert.equal(keysyms.has("F16"), false);
  assert.equal(keysyms.has("99"), false);
});

test("parseXkbcompKeysyms returns an empty set when no xkb_symbols section exists", () => {
  assert.equal(parseXkbcompKeysyms("xkb_keymap { };").size, 0);
});

test("reports present for a normal key found via xmodmap", () => {
  const { exec } = makeExec({ xmodmap: () => STOCK_XMODMAP });
  const deps = { execFileSync: exec, env: ENV_WITH_DISPLAY };
  assert.equal(checkKeysymAvailability("F8", deps), "present");
  assert.equal(checkKeysymAvailability("<Control>comma", deps), "present");
  assert.equal(checkKeysymAvailability("<Alt>space", deps), "present");
});

test("reports absent for F16 when the stock keymap maps the keycode to XF86Launch7", () => {
  const { exec } = makeExec({ xmodmap: () => STOCK_XMODMAP });
  const deps = { execFileSync: exec, env: ENV_WITH_DISPLAY };
  assert.equal(checkKeysymAvailability("F16", deps), "absent");
  assert.equal(checkKeysymAvailability("<Control><Shift>F16", deps), "absent");
});

test("falls back to xkbcomp when xmodmap is unavailable", () => {
  const { exec, calls } = makeExec({ xkbcomp: () => STOCK_XKBCOMP });
  const deps = { execFileSync: exec, env: ENV_WITH_DISPLAY };
  assert.equal(checkKeysymAvailability("F8", deps), "present");
  assert.deepEqual(
    calls.map((c) => c.file),
    ["xmodmap", "xkbcomp"]
  );
  assert.deepEqual(calls[1].args, ["-xkb", ":0", "-"]);
});

test("reports absent for F16 via the xkbcomp fallback", () => {
  const { exec } = makeExec({ xkbcomp: () => STOCK_XKBCOMP });
  assert.equal(
    checkKeysymAvailability("F16", { execFileSync: exec, env: ENV_WITH_DISPLAY }),
    "absent"
  );
});

test("fails open to unknown when both keymap queries fail", () => {
  const { exec } = makeExec({});
  assert.equal(
    checkKeysymAvailability("F16", { execFileSync: exec, env: ENV_WITH_DISPLAY }),
    "unknown"
  );
});

test("fails open to unknown without spawning anything when DISPLAY is unset", () => {
  const { exec, calls } = makeExec({ xmodmap: () => STOCK_XMODMAP });
  assert.equal(checkKeysymAvailability("F16", { execFileSync: exec, env: {} }), "unknown");
  assert.equal(calls.length, 0);
});

test("fails open to unknown when query output is implausibly small", () => {
  const { exec } = makeExec({
    xmodmap: () => "keycode 74 = F8\n",
    xkbcomp: () => 'xkb_symbols "x" { key <FK08> { [ F8 ] }; };',
  });
  assert.equal(
    checkKeysymAvailability("F16", { execFileSync: exec, env: ENV_WITH_DISPLAY }),
    "unknown"
  );
});

test("fails open to unknown for an empty or non-string shortcut", () => {
  const { exec, calls } = makeExec({ xmodmap: () => STOCK_XMODMAP });
  const deps = { execFileSync: exec, env: ENV_WITH_DISPLAY };
  assert.equal(checkKeysymAvailability("", deps), "unknown");
  assert.equal(checkKeysymAvailability(null, deps), "unknown");
  assert.equal(calls.length, 0);
});

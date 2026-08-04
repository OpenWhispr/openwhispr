const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/controlPanelWindowState.js");

const PRIMARY = { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1400 }, scaleFactor: 1 };
const SIDE = { id: 2, workArea: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const DISPLAYS = [PRIMARY, SIDE];

const savedState = (overrides = {}) => ({
  x: 100,
  y: 120,
  width: 1200,
  height: 800,
  isMaximized: false,
  displayId: 1,
  ...overrides,
});

test("serialize and parse round-trip a normal state", async () => {
  const { serializeControlPanelWindowState, parseControlPanelWindowState } = await load();

  const state = savedState();
  assert.deepEqual(parseControlPanelWindowState(serializeControlPanelWindowState(state)), state);
});

test("parse rejects malformed JSON, wrong shapes, and non-finite numbers", async () => {
  const { parseControlPanelWindowState } = await load();

  for (const raw of [
    undefined,
    null,
    "",
    "not-json",
    "42",
    '"string"',
    "[1,2,3]",
    "{}",
    '{"x":0,"y":0,"width":"1200","height":800}',
    '{"x":null,"y":0,"width":1200,"height":800}',
    '{"x":0,"y":0,"width":1e999,"height":800}',
  ]) {
    assert.equal(parseControlPanelWindowState(raw), null);
  }
});

test("parse drops zero, negative, and below-floor sizes", async () => {
  const { parseControlPanelWindowState } = await load();

  assert.equal(parseControlPanelWindowState('{"x":0,"y":0,"width":0,"height":800}'), null);
  assert.equal(parseControlPanelWindowState('{"x":0,"y":0,"width":1200,"height":-1}'), null);
  assert.equal(parseControlPanelWindowState('{"x":0,"y":0,"width":319,"height":800}'), null);
  assert.equal(parseControlPanelWindowState('{"x":0,"y":0,"width":1200,"height":239}'), null);
  assert.deepEqual(parseControlPanelWindowState('{"x":0,"y":0,"width":320,"height":240}'), {
    x: 0,
    y: 0,
    width: 320,
    height: 240,
    isMaximized: false,
    displayId: null,
  });
});

test("serialize returns empty string for invalid state so the store key is deleted", async () => {
  const { serializeControlPanelWindowState } = await load();

  assert.equal(serializeControlPanelWindowState(null), "");
  assert.equal(serializeControlPanelWindowState({ x: 0, y: 0, width: NaN, height: 800 }), "");
});

test("serialized state survives a KEY=value line in the env store", async () => {
  const { serializeControlPanelWindowState, parseControlPanelWindowState } = await load();
  const dotenv = require("dotenv");

  const state = savedState({ x: -400, y: 0, displayId: 123456789 });
  const line = `CONTROL_PANEL_WINDOW_STATE=${serializeControlPanelWindowState(state)}\n`;
  const parsedEnv = dotenv.parse(line);
  assert.deepEqual(parseControlPanelWindowState(parsedEnv.CONTROL_PANEL_WINDOW_STATE), state);
});

test("no saved state resolves to the default config path", async () => {
  const { resolveControlPanelWindowState } = await load();

  for (const saved of [null, undefined, {}, { x: 1, y: 2 }]) {
    assert.deepEqual(resolveControlPanelWindowState(saved, DISPLAYS, PRIMARY), {
      bounds: null,
      maximize: false,
    });
  }
});

test("bounds fully inside an attached display restore as-is", async () => {
  const { resolveControlPanelWindowState } = await load();

  const resolved = resolveControlPanelWindowState(savedState(), DISPLAYS, PRIMARY);
  assert.deepEqual(resolved, {
    bounds: { x: 100, y: 120, width: 1200, height: 800 },
    maximize: false,
  });
});

test("one pixel of overlap still counts as visible", async () => {
  const { resolveControlPanelWindowState } = await load();

  const saved = savedState({ x: -1199, y: 0 });
  const resolved = resolveControlPanelWindowState(saved, DISPLAYS, PRIMARY);
  assert.deepEqual(resolved.bounds, { x: -1199, y: 0, width: 1200, height: 800 });
});

test("an edge-adjacent window with zero overlap is off-screen", async () => {
  const { resolveControlPanelWindowState } = await load();

  const saved = savedState({ x: -1200, y: 0, displayId: 1 });
  const resolved = resolveControlPanelWindowState(saved, DISPLAYS, PRIMARY);
  assert.deepEqual(resolved.bounds, { x: 0, y: 0, width: 1200, height: 800 });
});

test("off-screen bounds clamp into the saved display when it is still attached", async () => {
  const { resolveControlPanelWindowState } = await load();

  const saved = savedState({ x: 9000, y: -3000, displayId: 2 });
  const resolved = resolveControlPanelWindowState(saved, DISPLAYS, PRIMARY);
  assert.deepEqual(resolved.bounds, { x: 3280, y: 0, width: 1200, height: 800 });
});

test("off-screen bounds center on the primary when the saved display is gone", async () => {
  const { resolveControlPanelWindowState } = await load();

  const saved = savedState({ x: 9000, y: 9000, displayId: 77 });
  const resolved = resolveControlPanelWindowState(saved, [PRIMARY], PRIMARY);
  assert.deepEqual(resolved.bounds, { x: 680, y: 300, width: 1200, height: 800 });
});

test("oversized bounds shrink to the primary work area when the saved display is gone", async () => {
  const { resolveControlPanelWindowState } = await load();

  const laptop = { id: 5, workArea: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 1 };
  const saved = savedState({ x: 4000, y: 0, width: 1600, height: 1000, displayId: 77 });
  const resolved = resolveControlPanelWindowState(saved, [laptop], laptop);
  assert.deepEqual(resolved.bounds, { x: 0, y: 0, width: 1440, height: 900 });
});

test("maximized flag survives restore, clamp, and fallback paths", async () => {
  const { resolveControlPanelWindowState } = await load();

  const visible = resolveControlPanelWindowState(
    savedState({ isMaximized: true }),
    DISPLAYS,
    PRIMARY
  );
  assert.equal(visible.maximize, true);

  const clamped = resolveControlPanelWindowState(
    savedState({ x: 9000, y: -3000, displayId: 2, isMaximized: true }),
    DISPLAYS,
    PRIMARY
  );
  assert.equal(clamped.maximize, true);

  const centered = resolveControlPanelWindowState(
    savedState({ x: 9000, y: 9000, displayId: 77, isMaximized: true }),
    [PRIMARY],
    PRIMARY
  );
  assert.equal(centered.maximize, true);
});

test("a window spanning two displays restores untouched", async () => {
  const { resolveControlPanelWindowState } = await load();

  const saved = savedState({ x: 2000, y: 100, width: 1600, height: 800 });
  const resolved = resolveControlPanelWindowState(saved, DISPLAYS, PRIMARY);
  assert.deepEqual(resolved.bounds, { x: 2000, y: 100, width: 1600, height: 800 });
});

test("DIP bounds left outside a rescaled work area clamp back in", async () => {
  const { resolveControlPanelWindowState } = await load();

  // Same physical panel, scale went 1 -> 2, so the DIP work area halved.
  const rescaled = { id: 1, workArea: { x: 0, y: 0, width: 1280, height: 700 }, scaleFactor: 2 };
  const saved = savedState({ x: 1400, y: 800, width: 1200, height: 800, displayId: 1 });
  const resolved = resolveControlPanelWindowState(saved, [rescaled], rescaled);
  assert.deepEqual(resolved.bounds, { x: 80, y: 0, width: 1200, height: 700 });
});

test("an empty display list falls back to the default config path but keeps the flag", async () => {
  const { resolveControlPanelWindowState } = await load();

  const resolved = resolveControlPanelWindowState(savedState({ isMaximized: true }), [], null);
  assert.deepEqual(resolved, { bounds: null, maximize: true });
});

test("non-numeric display ids are ignored instead of matching a display", async () => {
  const { parseControlPanelWindowState, resolveControlPanelWindowState } = await load();

  const parsed = parseControlPanelWindowState(
    '{"x":9000,"y":9000,"width":1200,"height":800,"displayId":"2"}'
  );
  assert.equal(parsed.displayId, null);

  const resolved = resolveControlPanelWindowState(parsed, DISPLAYS, PRIMARY);
  assert.deepEqual(resolved.bounds, { x: 680, y: 300, width: 1200, height: 800 });
});

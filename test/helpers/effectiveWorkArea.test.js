const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parsePlasmaScreens,
  matchDisplayToPlasmaScreen,
  computeEffectiveWorkArea,
} = require("../../src/helpers/effectiveWorkArea.js");

// Live layout of the reference machine: two 1920x1080 monitors side by side, each with a
// 28px top and a 32px bottom always-visible panel.
const THIS_MACHINE_REPLY = JSON.stringify({
  screens: [
    { i: 0, x: 0, y: 0, w: 1920, h: 1080 },
    { i: 1, x: 1920, y: 0, w: 1920, h: 1080 },
  ],
  panels: [
    { screen: 0, location: "top", height: 28, hiding: "none" },
    { screen: 0, location: "bottom", height: 32, hiding: "none" },
    { screen: 1, location: "top", height: 28, hiding: "none" },
    { screen: 1, location: "bottom", height: 32, hiding: "none" },
  ],
});

// ---- parsePlasmaScreens ----------------------------------------------------------------

test("parsePlasmaScreens reads the 4-panel live layout into per-screen insets", () => {
  const screens = parsePlasmaScreens(THIS_MACHINE_REPLY);
  assert.deepEqual(screens, [
    { x: 0, y: 0, w: 1920, h: 1080, insets: { top: 28, right: 0, bottom: 32, left: 0 } },
    { x: 1920, y: 0, w: 1920, h: 1080, insets: { top: 28, right: 0, bottom: 32, left: 0 } },
  ]);
});

test("parsePlasmaScreens ignores panels that are not always-visible (hiding !== none)", () => {
  const reply = JSON.stringify({
    screens: [{ i: 0, x: 0, y: 0, w: 1920, h: 1080 }],
    panels: [
      { screen: 0, location: "top", height: 28, hiding: "none" },
      { screen: 0, location: "bottom", height: 100, hiding: "autohide" },
      { screen: 0, location: "bottom", height: 40, hiding: "dodgewindows" },
    ],
  });
  const [screen] = parsePlasmaScreens(reply);
  assert.deepEqual(screen.insets, { top: 28, right: 0, bottom: 0, left: 0 });
});

test("parsePlasmaScreens takes the MAX thickness per edge, never the sum", () => {
  const reply = JSON.stringify({
    screens: [{ i: 0, x: 0, y: 0, w: 1920, h: 1080 }],
    panels: [
      { screen: 0, location: "top", height: 28, hiding: "none" },
      { screen: 0, location: "top", height: 40, hiding: "none" },
    ],
  });
  const [screen] = parsePlasmaScreens(reply);
  assert.equal(screen.insets.top, 40);
});

test("parsePlasmaScreens handles vertical panels (width, fallback to height)", () => {
  const reply = JSON.stringify({
    screens: [{ i: 0, x: 0, y: 0, w: 1920, h: 1080 }],
    panels: [
      { screen: 0, location: "left", width: 50, height: 1080, hiding: "none" },
      { screen: 0, location: "right", height: 60, hiding: "none" },
    ],
  });
  const [screen] = parsePlasmaScreens(reply);
  assert.equal(screen.insets.left, 50);
  assert.equal(screen.insets.right, 60);
});

test("parsePlasmaScreens returns [] for malformed / empty / garbage replies", () => {
  const junk = [
    "",
    "not json",
    "null",
    "{}",
    "[]",
    JSON.stringify([1, 2, 3]),
    JSON.stringify({ screens: "nope" }),
    JSON.stringify({ screens: [] }),
    null,
    undefined,
    42,
    JSON.stringify({ panels: [{ screen: 0, location: "top", height: 28, hiding: "none" }] }),
  ];
  for (const value of junk) {
    assert.deepEqual(parsePlasmaScreens(value), [], `expected [] for ${JSON.stringify(value)}`);
  }
});

test("parsePlasmaScreens skips individually malformed screens and panels", () => {
  const reply = JSON.stringify({
    screens: [
      { i: 0, x: 0, y: 0, w: 1920, h: 1080 },
      { i: 1, x: 1920, y: 0, w: 0, h: 1080 }, // zero width -> skipped
      { i: 2, x: "x", y: 0, w: 1920, h: 1080 }, // non-numeric -> skipped
    ],
    panels: [
      null,
      { screen: 0, location: "top", height: 28, hiding: "none" },
      { location: "top", height: 99, hiding: "none" }, // no screen -> ignored
    ],
  });
  const screens = parsePlasmaScreens(reply);
  assert.equal(screens.length, 1);
  assert.deepEqual(screens[0].insets, { top: 28, right: 0, bottom: 0, left: 0 });
});

// ---- matchDisplayToPlasmaScreen --------------------------------------------------------

test("matchDisplayToPlasmaScreen matches an exact same-scale display", () => {
  const screens = parsePlasmaScreens(THIS_MACHINE_REPLY);
  const allBounds = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 1920, height: 1080 },
  ];
  const display = { id: 2, bounds: allBounds[1] };
  const matched = matchDisplayToPlasmaScreen(display, screens, allBounds);
  assert.ok(matched);
  assert.equal(matched.x, 1920);
});

test("matchDisplayToPlasmaScreen matches through mixed-scale off-by-ones", () => {
  // Reporter's mixed-DPI layout: Electron DIP bounds are a few px off Plasma logical geometry.
  const screens = [
    { x: 1920, y: 0, w: 2258, h: 1270, insets: { top: 0, right: 0, bottom: 46, left: 0 } },
    { x: 0, y: 0, w: 1920, h: 1080, insets: { top: 26, right: 0, bottom: 0, left: 0 } },
  ];
  const display4k = { id: 1, bounds: { x: 1916, y: 0, width: 2256, height: 1269 } };
  const display1080 = { id: 2, bounds: { x: -1, y: 0, width: 1918, height: 1079 } };
  const allBounds = [display4k.bounds, display1080.bounds];
  assert.equal(matchDisplayToPlasmaScreen(display4k, screens, allBounds).w, 2258);
  assert.equal(matchDisplayToPlasmaScreen(display1080, screens, allBounds).w, 1920);
});

test("matchDisplayToPlasmaScreen returns null for mirrored / ambiguous screens", () => {
  const screens = [
    { x: 0, y: 0, w: 1920, h: 1080, insets: { top: 28, right: 0, bottom: 0, left: 0 } },
    { x: 0, y: 0, w: 1920, h: 1080, insets: { top: 28, right: 0, bottom: 0, left: 0 } },
  ];
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  assert.equal(matchDisplayToPlasmaScreen(display, screens), null);
});

test("matchDisplayToPlasmaScreen returns null for an empty list or invalid display", () => {
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  assert.equal(matchDisplayToPlasmaScreen(display, []), null);
  assert.equal(matchDisplayToPlasmaScreen(display, null), null);
  assert.equal(matchDisplayToPlasmaScreen({ id: 1, bounds: null }, [{ x: 0, y: 0, w: 1, h: 1 }]), null);
  assert.equal(matchDisplayToPlasmaScreen(null, [{ x: 0, y: 0, w: 1, h: 1 }]), null);
});

test("matchDisplayToPlasmaScreen matches across a uniform scale difference (KDE X11 at 200%)", () => {
  // Electron DIP layout is the device layout halved; Plasma reports device pixels.
  const allBounds = [
    { x: 0, y: 0, width: 960, height: 540 },
    { x: 960, y: 0, width: 960, height: 540 },
  ];
  const screens = [
    { x: 0, y: 0, w: 1920, h: 1080, insets: { top: 0, right: 0, bottom: 36, left: 0 } },
    { x: 1920, y: 0, w: 1920, h: 1080, insets: { top: 0, right: 0, bottom: 32, left: 0 } },
  ];
  const display = { id: 2, bounds: allBounds[1] };
  const matched = matchDisplayToPlasmaScreen(display, screens, allBounds);
  assert.ok(matched);
  assert.equal(matched.x, 1920);
  assert.deepEqual(computeEffectiveWorkArea(display, matched), {
    x: 960,
    y: 0,
    width: 960,
    height: 524,
  });
});

test("matchDisplayToPlasmaScreen refuses to guess when screen counts diverge", () => {
  const screens = [
    { x: 0, y: 0, w: 1920, h: 1080, insets: { top: 28, right: 0, bottom: 0, left: 0 } },
    { x: 1920, y: 0, w: 1920, h: 1080, insets: { top: 28, right: 0, bottom: 0, left: 0 } },
  ];
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  assert.equal(matchDisplayToPlasmaScreen(display, screens), null);
});

// ---- computeEffectiveWorkArea ----------------------------------------------------------

test("computeEffectiveWorkArea corrects the reference machine's non-primary display", () => {
  const display = { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const screen = { x: 1920, y: 0, w: 1920, h: 1080, insets: { top: 28, right: 0, bottom: 32, left: 0 } };
  assert.deepEqual(computeEffectiveWorkArea(display, screen), {
    x: 1920,
    y: 28,
    width: 1920,
    height: 1020,
  });
});

test("computeEffectiveWorkArea replaces a bogus inherited inset with the true scaled panel", () => {
  // Reporter's 4K primary: Electron reported a bogus 236px bottom inset (height 1033).
  const display = { id: 1, bounds: { x: 1916, y: 0, width: 2256, height: 1269 } };
  const screen = { x: 1920, y: 0, w: 2258, h: 1270, insets: { top: 0, right: 0, bottom: 46, left: 0 } };
  const wa = computeEffectiveWorkArea(display, screen);
  const bottomInset = display.bounds.height - wa.height - (wa.y - display.bounds.y);
  assert.equal(bottomInset, 46);
  assert.notEqual(bottomInset, 236);
  assert.deepEqual(wa, { x: 1916, y: 0, width: 2256, height: 1223 });
});

test("computeEffectiveWorkArea gives a bounds==workArea display its own panel inset", () => {
  // Reporter's 1080p: Electron had workArea == bounds (inset 0); it should gain its top panel.
  const display = { id: 2, bounds: { x: -1, y: 0, width: 1918, height: 1079 } };
  const screen = { x: 0, y: 0, w: 1920, h: 1080, insets: { top: 26, right: 0, bottom: 0, left: 0 } };
  const wa = computeEffectiveWorkArea(display, screen);
  assert.equal(wa.x, -1); // negative origin preserved
  assert.equal(wa.y, 26); // gained the top panel instead of 0
  assert.deepEqual(wa, { x: -1, y: 26, width: 1918, height: 1053 });
});

test("computeEffectiveWorkArea preserves a negative origin (monitor left of primary)", () => {
  const display = { id: 3, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } };
  const screen = { x: -1920, y: 0, w: 1920, h: 1080, insets: { top: 28, right: 0, bottom: 32, left: 0 } };
  assert.deepEqual(computeEffectiveWorkArea(display, screen), {
    x: -1920,
    y: 28,
    width: 1920,
    height: 1020,
  });
});

test("computeEffectiveWorkArea returns null for insane insets (> 45% of the dimension)", () => {
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const screen = { x: 0, y: 0, w: 1920, h: 1080, insets: { top: 600, right: 0, bottom: 0, left: 0 } };
  assert.equal(computeEffectiveWorkArea(display, screen), null);
});

test("computeEffectiveWorkArea returns null for degenerate inputs", () => {
  const screen = { x: 0, y: 0, w: 1920, h: 1080, insets: { top: 28, right: 0, bottom: 0, left: 0 } };
  assert.equal(
    computeEffectiveWorkArea({ id: 1, bounds: { x: 0, y: 0, width: 0, height: 1080 } }, screen),
    null
  );
  assert.equal(
    computeEffectiveWorkArea(
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { x: 0, y: 0, w: 0, h: 1080, insets: { top: 28, right: 0, bottom: 0, left: 0 } }
    ),
    null
  );
  assert.equal(computeEffectiveWorkArea(null, screen), null);
  assert.equal(
    computeEffectiveWorkArea({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, null),
    null
  );
});

test("computeEffectiveWorkArea with no panels leaves the work area equal to bounds", () => {
  const display = { id: 1, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const screen = { x: 1920, y: 0, w: 1920, h: 1080, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
  assert.deepEqual(computeEffectiveWorkArea(display, screen), {
    x: 1920,
    y: 0,
    width: 1920,
    height: 1080,
  });
});

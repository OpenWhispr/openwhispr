const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTO_DISPLAY,
  decodeDisplayChoice,
  sanitizePanelDisplayValue,
  resolveTargetDisplay,
} = require("../../src/helpers/displaySelection.js");

// Spatial layout used across most tests:
//   primary (id 1) at x=0, a monitor (id 2) to its right, a monitor (id 3) to its left.
const makeDisplay = (id, label, bounds) => ({ id, label, bounds });

const PRIMARY = makeDisplay(1, "Built-in Retina", { x: 0, y: 0, width: 1440, height: 900 });
const RIGHT = makeDisplay(2, "DELL U2720Q", { x: 1440, y: 0, width: 2560, height: 1440 });
const LEFT = makeDisplay(3, "LG HDR 4K", { x: -1920, y: 0, width: 1920, height: 1080 });
const ALL = [LEFT, PRIMARY, RIGHT];

const encode = (display) =>
  JSON.stringify({ id: display.id, label: display.label, bounds: display.bounds });

test("auto value resolves to the fallback display", () => {
  assert.equal(resolveTargetDisplay(AUTO_DISPLAY, ALL, PRIMARY), PRIMARY);
  assert.equal(resolveTargetDisplay("auto", ALL, RIGHT), RIGHT);
});

test("malformed / non-JSON / wrong-shape values resolve to the fallback display", () => {
  const junk = [
    "",
    "{}",
    "null",
    "not json",
    "[]",
    '{"id":1}',
    '{"id":"x","label":"","bounds":{}}',
    '{"label":"DELL U2720Q","bounds":{"x":1440,"y":0,"width":2560,"height":1440}}',
    '{"id":2,"label":"x","bounds":{"x":1,"y":2,"width":"3","height":4}}',
    undefined,
    null,
    42,
  ];
  for (const value of junk) {
    assert.equal(
      resolveTargetDisplay(value, ALL, PRIMARY),
      PRIMARY,
      `expected fallback for ${JSON.stringify(value)}`
    );
  }
});

test("exact id match wins even when bounds differ", () => {
  // Same id as RIGHT but stale bounds that overlap PRIMARY's region.
  const choice = JSON.stringify({
    id: 2,
    label: "DELL U2720Q",
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
  });
  assert.equal(resolveTargetDisplay(choice, ALL, PRIMARY), RIGHT);
});

test("id absent but non-empty unique label matches by label", () => {
  // id 99 is gone; label still uniquely identifies RIGHT. Bounds shifted so they
  // would overlap PRIMARY most, proving label takes precedence over bounds.
  const choice = JSON.stringify({
    id: 99,
    label: "DELL U2720Q",
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
  });
  assert.equal(resolveTargetDisplay(choice, ALL, PRIMARY), RIGHT);
});

test("empty label skips the label match and must not match another empty-label display", () => {
  // Two displays with empty labels (Linux/XWayland). Choice has empty label and an
  // unknown id, so it must fall through to bounds overlap, not match by empty label.
  const a = makeDisplay(10, "", { x: 0, y: 0, width: 1920, height: 1080 });
  const b = makeDisplay(11, "", { x: 1920, y: 0, width: 1920, height: 1080 });
  const displays = [a, b];
  const choice = JSON.stringify({
    id: 999,
    label: "",
    bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
  });
  // Bounds overlap b exactly, not a; empty-label match must not fire for a.
  assert.equal(resolveTargetDisplay(choice, displays, a), b);
});

test("empty label with no bounds overlap falls back", () => {
  const a = makeDisplay(10, "", { x: 0, y: 0, width: 1920, height: 1080 });
  const b = makeDisplay(11, "", { x: 1920, y: 0, width: 1920, height: 1080 });
  const choice = JSON.stringify({
    id: 999,
    label: "",
    bounds: { x: 99999, y: 99999, width: 100, height: 100 },
  });
  assert.equal(resolveTargetDisplay(choice, [a, b], a), a);
});

test("two displays share identical bounds: id still disambiguates", () => {
  const clash = { x: 0, y: 0, width: 1440, height: 900 };
  const d1 = makeDisplay(1, "Monitor A", clash);
  const d2 = makeDisplay(2, "Monitor B", clash);
  const displays = [d1, d2];
  assert.equal(resolveTargetDisplay(encode(d2), displays, d1), d2);
  assert.equal(resolveTargetDisplay(encode(d1), displays, d2), d1);
});

test("two displays share identical bounds: label disambiguates when id is gone", () => {
  const clash = { x: 0, y: 0, width: 1440, height: 900 };
  const d1 = makeDisplay(1, "Monitor A", clash);
  const d2 = makeDisplay(2, "Monitor B", clash);
  const displays = [d1, d2];
  const choice = JSON.stringify({ id: 777, label: "Monitor B", bounds: clash });
  assert.equal(resolveTargetDisplay(choice, displays, d1), d2);
});

test("chosen monitor disconnected (id and label gone, no bounds overlap) -> fallback", () => {
  // Only PRIMARY remains; the choice describes a monitor that no longer exists.
  const choice = JSON.stringify({
    id: 2,
    label: "DELL U2720Q",
    bounds: { x: 1440, y: 0, width: 2560, height: 1440 },
  });
  assert.equal(resolveTargetDisplay(choice, [PRIMARY], PRIMARY), PRIMARY);
});

test("bounds-overlap match picks the display with the largest intersection", () => {
  // id and label absent. Choice overlaps RIGHT a little and PRIMARY a lot.
  const choice = JSON.stringify({
    id: 555,
    label: "Unknown Monitor",
    bounds: { x: -100, y: 0, width: 1540, height: 900 },
  });
  // Overlap with PRIMARY (0..1440) is 1340x900; with LEFT (-1920..0) is 100x900.
  assert.equal(resolveTargetDisplay(choice, ALL, RIGHT), PRIMARY);
});

test("zero-area (touching but not overlapping) bounds do not count as overlap", () => {
  // Choice sits exactly to the right of RIGHT, sharing only an edge.
  const choice = JSON.stringify({
    id: 555,
    label: "Ghost",
    bounds: { x: 4000, y: 0, width: 0, height: 1440 },
  });
  assert.equal(resolveTargetDisplay(choice, ALL, LEFT), LEFT);
});

test("a chosen display with negative x (monitor left of primary) resolves correctly", () => {
  assert.equal(resolveTargetDisplay(encode(LEFT), ALL, PRIMARY), LEFT);

  // Same negative-x monitor resolved purely by bounds overlap (id/label stale).
  const choice = JSON.stringify({
    id: 4242,
    label: "Different Name",
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  });
  assert.equal(resolveTargetDisplay(choice, ALL, PRIMARY), LEFT);
});

test("decodeDisplayChoice returns null for auto and validates bounds members are numbers", () => {
  assert.equal(decodeDisplayChoice(AUTO_DISPLAY), null);
  assert.equal(decodeDisplayChoice("auto"), null);
  assert.equal(decodeDisplayChoice(""), null);
  assert.equal(decodeDisplayChoice("null"), null);
  assert.equal(decodeDisplayChoice("{}"), null);
  assert.equal(decodeDisplayChoice('{"id":1}'), null);
  assert.equal(decodeDisplayChoice('{"id":1,"label":"x"}'), null);
  assert.equal(decodeDisplayChoice(undefined), null);
  assert.equal(decodeDisplayChoice(null), null);
  assert.equal(decodeDisplayChoice(123), null);

  // Each bounds member must be a finite number.
  assert.equal(
    decodeDisplayChoice('{"id":1,"label":"x","bounds":{"x":"0","y":0,"width":1,"height":1}}'),
    null
  );
  assert.equal(
    decodeDisplayChoice('{"id":1,"label":"x","bounds":{"x":0,"y":0,"width":1}}'),
    null
  );
  assert.equal(
    decodeDisplayChoice('{"id":1,"label":"x","bounds":{"x":0,"y":0,"width":null,"height":1}}'),
    null
  );

  // id must be a number, label must be a string (empty allowed).
  assert.equal(
    decodeDisplayChoice('{"id":"1","label":"x","bounds":{"x":0,"y":0,"width":1,"height":1}}'),
    null
  );
  assert.equal(
    decodeDisplayChoice('{"id":1,"label":5,"bounds":{"x":0,"y":0,"width":1,"height":1}}'),
    null
  );

  const ok = decodeDisplayChoice(
    '{"id":2,"label":"DELL U2720Q","bounds":{"x":1440,"y":0,"width":2560,"height":1440}}'
  );
  assert.deepEqual(ok, {
    id: 2,
    label: "DELL U2720Q",
    bounds: { x: 1440, y: 0, width: 2560, height: 1440 },
  });

  // Empty label is a valid choice (Linux/XWayland).
  const emptyLabel = decodeDisplayChoice(
    '{"id":3,"label":"","bounds":{"x":0,"y":0,"width":100,"height":100}}'
  );
  assert.deepEqual(emptyLabel, {
    id: 3,
    label: "",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  });
});

test("decodeDisplayChoice rejects non-finite numbers", () => {
  // JSON cannot carry NaN/Infinity, but an already-parsed-then-restringified value
  // could in theory; ensure the validator is strict against them via direct input.
  assert.equal(
    decodeDisplayChoice('{"id":1,"label":"x","bounds":{"x":1e999,"y":0,"width":1,"height":1}}'),
    null
  );
});

test("sanitizePanelDisplayValue maps junk to auto", () => {
  for (const value of ["", "{}", "null", "garbage", '{"id":1}', undefined, null, 42, "auto"]) {
    assert.equal(sanitizePanelDisplayValue(value), AUTO_DISPLAY);
  }
});

test("sanitizePanelDisplayValue re-encodes a valid choice canonically", () => {
  // Reordered keys and an extra unrelated field should canonicalize to the strict shape.
  const messy = JSON.stringify({
    bounds: { height: 1440, width: 2560, y: 0, x: 1440 },
    extra: "ignored",
    label: "DELL U2720Q",
    id: 2,
  });
  const canonical = sanitizePanelDisplayValue(messy);
  assert.equal(
    canonical,
    JSON.stringify({
      id: 2,
      label: "DELL U2720Q",
      bounds: { x: 1440, y: 0, width: 2560, height: 1440 },
    })
  );
  // Canonical output must round-trip through decode unchanged.
  assert.equal(sanitizePanelDisplayValue(canonical), canonical);
});

test("resolveTargetDisplay returns fallback when display list is empty or invalid", () => {
  const choice = encode(RIGHT);
  assert.equal(resolveTargetDisplay(choice, [], PRIMARY), PRIMARY);
  assert.equal(resolveTargetDisplay(choice, null, PRIMARY), PRIMARY);
  assert.equal(resolveTargetDisplay(choice, undefined, PRIMARY), PRIMARY);
});

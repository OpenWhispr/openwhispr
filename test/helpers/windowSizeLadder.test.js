const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/windowSizeLadder.js");

test("recording window only grows enough for the compact listening pill", () => {
  const { WINDOW_SIZES } = require("../../src/helpers/windowConfig");
  assert.deepEqual(WINDOW_SIZES.RECORDING, { width: 128, height: 96 });
});

test("base state with nothing active", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: false,
      toastCount: 0,
      compactPill: false,
    }),
    "BASE"
  );
});

test("compact listening pill grows the window", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: false,
      toastCount: 0,
      compactPill: true,
    }),
    "RECORDING"
  );
});

test("a toast outranks the listening pill so both fit", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: false,
      toastCount: 1,
      compactPill: true,
    }),
    "WITH_TOAST"
  );
});

test("menu over a listening pill needs the expanded window", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: true,
      toastCount: 0,
      compactPill: true,
    }),
    "EXPANDED"
  );
});

test("menu alone uses the menu size", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: true,
      toastCount: 0,
      compactPill: false,
    }),
    "WITH_MENU"
  );
});

test("the assistant panel wins over everything", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: true,
      menuOpen: true,
      toastCount: 2,
      compactPill: true,
    }),
    "ASSISTANT"
  );
  assert.equal(
    resolveMainWindowSizeKey({
      panelOpen: true,
      menuOpen: false,
      toastCount: 0,
      compactPill: false,
    }),
    "ASSISTANT"
  );
});

test("a toast dismissing never shrinks the window below an active state", async () => {
  const { resolveMainWindowSizeKey, SIZE_RANK } = await load();
  // Toast dismissal while recording resolves to RECORDING, not BASE.
  const during = resolveMainWindowSizeKey({
    panelOpen: false,
    menuOpen: false,
    toastCount: 0,
    compactPill: true,
  });
  assert.equal(during, "RECORDING");
  assert.ok(SIZE_RANK[during] > SIZE_RANK.BASE);
});

test("size ranks order every key", async () => {
  const { SIZE_RANK } = await load();
  assert.ok(
    SIZE_RANK.BASE < SIZE_RANK.RECORDING &&
      SIZE_RANK.RECORDING < SIZE_RANK.WITH_MENU &&
      SIZE_RANK.WITH_MENU < SIZE_RANK.WITH_TOAST &&
      SIZE_RANK.WITH_TOAST < SIZE_RANK.EXPANDED &&
      SIZE_RANK.EXPANDED < SIZE_RANK.ASSISTANT
  );
});

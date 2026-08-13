const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/windowSizeLadder.js");

test("base state with nothing active", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({ panelOpen: false, menuOpen: false, toastCount: 0, capsule: false }),
    "BASE"
  );
});

test("recording capsule grows the window", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({ panelOpen: false, menuOpen: false, toastCount: 0, capsule: true }),
    "RECORDING"
  );
});

test("a toast outranks the capsule so both fit", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({ panelOpen: false, menuOpen: false, toastCount: 1, capsule: true }),
    "WITH_TOAST"
  );
});

test("menu over a capsule needs the expanded window", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({ panelOpen: false, menuOpen: true, toastCount: 0, capsule: true }),
    "EXPANDED"
  );
});

test("menu alone uses the menu size", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({ panelOpen: false, menuOpen: true, toastCount: 0, capsule: false }),
    "WITH_MENU"
  );
});

test("the assistant panel wins over everything", async () => {
  const { resolveMainWindowSizeKey } = await load();
  assert.equal(
    resolveMainWindowSizeKey({ panelOpen: true, menuOpen: true, toastCount: 2, capsule: true }),
    "ASSISTANT"
  );
  assert.equal(
    resolveMainWindowSizeKey({ panelOpen: true, menuOpen: false, toastCount: 0, capsule: false }),
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
    capsule: true,
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

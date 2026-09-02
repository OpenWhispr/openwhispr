const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/windowSizeLadder.js");

const resting = {
  panelOpen: false,
  menuOpen: false,
  toastCount: 0,
  compactPill: false,
  dictationErrorActionCount: 0,
};

test("a visible hands-free tip grows the resting pill window", async () => {
  const { resolveMainWindowSizeKey, SIZE_RANK } = await load();

  assert.equal(
    resolveMainWindowSizeKey({ ...resting, handsFreeTipVisible: true }),
    "HANDS_FREE_TIP"
  );
  assert.equal(resolveMainWindowSizeKey(resting), "BASE");
  assert.ok(SIZE_RANK.HANDS_FREE_TIP > SIZE_RANK.RECORDING);
  assert.ok(SIZE_RANK.HANDS_FREE_TIP < SIZE_RANK.DICTATION_ERROR);
});

test("an error card and the command menu both outrank the hands-free tip", async () => {
  const { resolveMainWindowSizeKey } = await load();

  assert.equal(
    resolveMainWindowSizeKey({
      ...resting,
      handsFreeTipVisible: true,
      dictationErrorActionCount: 1,
    }),
    "DICTATION_ERROR"
  );
  assert.equal(
    resolveMainWindowSizeKey({ ...resting, handsFreeTipVisible: true, menuOpen: true }),
    "WITH_MENU"
  );
});

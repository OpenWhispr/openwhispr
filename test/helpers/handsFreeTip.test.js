const test = require("node:test");
const assert = require("node:assert/strict");

const storage = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
};

const load = () => import("../../src/helpers/handsFreeTip.js");

test("a hold shorter than two minutes does not earn the tip", async () => {
  const { createHandsFreeTipGate, HANDS_FREE_TIP_HOLD_MS } = await load();
  const gate = createHandsFreeTipGate(storage());

  assert.equal(HANDS_FREE_TIP_HOLD_MS, 120000);
  assert.equal(gate.qualifies(HANDS_FREE_TIP_HOLD_MS - 1), false);
  assert.equal(gate.qualifies(HANDS_FREE_TIP_HOLD_MS), true);
});

test("the tip shows at most once per launch", async () => {
  const { createHandsFreeTipGate } = await load();
  const gate = createHandsFreeTipGate(storage());

  assert.equal(gate.qualifies(150000), true);
  gate.markShown();
  assert.equal(gate.qualifies(150000), false);
});

test("the tip retires after three showings across launches", async () => {
  const { createHandsFreeTipGate, HANDS_FREE_TIP_MAX_SHOWS } = await load();
  const store = storage();
  for (let launch = 0; launch < HANDS_FREE_TIP_MAX_SHOWS; launch += 1) {
    const gate = createHandsFreeTipGate(store);
    assert.equal(gate.qualifies(150000), true, `launch ${launch} should still offer`);
    gate.markShown();
  }

  assert.equal(createHandsFreeTipGate(store).qualifies(150000), false);
  assert.equal(store.dump().handsFreeTipShownCount, String(HANDS_FREE_TIP_MAX_SHOWS));
});

test("using hands-free retires the tip for good", async () => {
  const { createHandsFreeTipGate } = await load();
  const store = storage();
  createHandsFreeTipGate(store).markHandsFreeUsed();

  assert.equal(createHandsFreeTipGate(store).qualifies(150000), false);
});

test("the tip names the held slot's first binding", async () => {
  const { resolveHandsFreeTipHotkey } = await load();
  const keys = {
    dictationKey: "F8,Control+`",
    voiceAgentKey: "Alt+Space",
    translationKey: "Control+Shift+T",
  };

  assert.equal(resolveHandsFreeTipHotkey("dictation", keys), "F8");
  assert.equal(resolveHandsFreeTipHotkey("assistant", keys), "Alt+Space");
  assert.equal(resolveHandsFreeTipHotkey("translation", keys), "Control+Shift+T");
});

test("an unset dictation binding falls back to the platform default", async () => {
  const { resolveHandsFreeTipHotkey } = await load();
  const { getDefaultHotkey } = await import("../../src/utils/hotkeys.ts");

  assert.equal(
    resolveHandsFreeTipHotkey("dictation", {
      dictationKey: "",
      voiceAgentKey: "",
      translationKey: "",
    }),
    getDefaultHotkey()
  );
});

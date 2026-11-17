const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

// The hook mounted for real, with its props set from the test and node's
// mock timers standing in for the four seconds.
async function mountNudge(t, initial) {
  let root = null;
  t.after(() => root && React.act(async () => root.unmount()));
  const happyWindow = await installHappyDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-answer-nudge-" });
  const { useAnswerNudge, ANSWER_NUDGE_MS } = await vite.ssrLoadModule(
    "/components/agent/useAnswerNudge.ts"
  );
  const opened = [];
  let latest = null;
  function Harness(props) {
    latest = useAnswerNudge({ ...props, onOpen: () => opened.push(props.pendingKey) });
    return null;
  }
  const { createRoot } = require("react-dom/client");
  root = createRoot(happyWindow.document.createElement("div"));
  let props = initial;
  const render = (next) => {
    props = { ...props, ...next };
    return React.act(async () => root.render(React.createElement(Harness, props)));
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await render({});
  const tick = (ms) => React.act(async () => t.mock.timers.tick(ms));
  return { render, tick, opened, nudge: () => latest, ms: ANSWER_NUDGE_MS };
}

const WAITING = { pendingKey: "m1::c1", compact: true, visible: true };

test("a waiting card cues Expand, then opens the modal once, after about four seconds", async (t) => {
  const view = await mountNudge(t, WAITING);
  assert.equal(view.ms, 4000);
  assert.equal(view.nudge().cue, true);
  await view.tick(3999);
  assert.deepEqual(view.opened, []);
  await view.tick(1);
  assert.deepEqual(view.opened, ["m1::c1"]);
  assert.equal(view.nudge().cue, false);

  // Minimized again: it stays minimized.
  await view.render({ compact: false });
  await view.render({ compact: true });
  await view.tick(10_000);
  assert.deepEqual(view.opened, ["m1::c1"]);
  assert.equal(view.nudge().cue, false);
});

test("moving between the pill and the card above it keeps the same timer", async (t) => {
  const view = await mountNudge(t, WAITING);
  await view.tick(2000);
  // Both are compact: re-rendering with the same props is all a layout change does here.
  await view.render({ compact: true });
  await view.tick(2000);
  assert.deepEqual(view.opened, ["m1::c1"]);
});

test("it stops when the card is answered or dismissed", async (t) => {
  const view = await mountNudge(t, WAITING);
  await view.tick(1000);
  await view.render({ pendingKey: null });
  assert.equal(view.nudge().cue, false);
  await view.tick(10_000);
  assert.deepEqual(view.opened, []);
});

for (const [why, change] of [
  ["the modal opens by itself (the reply's own expand)", { compact: false }],
  ["the window hides", { visible: false }],
  ["a voice take starts", { paused: true }],
]) {
  test(`it only pauses when ${why}, and starts over after`, async (t) => {
    const view = await mountNudge(t, WAITING);
    await view.tick(3000);
    await view.render(change);
    assert.equal(view.nudge().cue, false);
    await view.tick(10_000);
    assert.deepEqual(view.opened, [], "nothing opens meanwhile");

    await view.render({ compact: true, visible: true, paused: false });
    assert.equal(view.nudge().cue, true, "cued again");
    await view.tick(3999);
    assert.deepEqual(view.opened, [], "a fresh four seconds");
    await view.tick(1);
    assert.deepEqual(view.opened, ["m1::c1"]);
  });
}

test("a voice take that starts with the card never arms it", async (t) => {
  const view = await mountNudge(t, { ...WAITING, paused: true });
  assert.equal(view.nudge().cue, false);
  await view.tick(10_000);
  assert.deepEqual(view.opened, []);
});

test("the user acting on the card stops it for good", async (t) => {
  const view = await mountNudge(t, WAITING);
  await React.act(async () => view.nudge().cancel());
  assert.equal(view.nudge().cue, false);
  await view.tick(10_000);
  assert.deepEqual(view.opened, []);

  // Expand pressed, then minimized again: it stays minimized.
  await view.render({ compact: false });
  await view.render({ compact: true });
  assert.equal(view.nudge().cue, false);
  await view.tick(10_000);
  assert.deepEqual(view.opened, []);
});

test("each new card gets its own nudge", async (t) => {
  const view = await mountNudge(t, WAITING);
  await view.tick(4000);
  await view.render({ pendingKey: "m1::c2" });
  assert.equal(view.nudge().cue, true);
  await view.tick(4000);
  assert.deepEqual(view.opened, ["m1::c1", "m1::c2"]);
});

test("a card that arrives while the modal is open never nudges", async (t) => {
  const view = await mountNudge(t, { ...WAITING, compact: false });
  assert.equal(view.nudge().cue, false);
  await view.tick(10_000);
  assert.deepEqual(view.opened, []);
});

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

for (const [why, change] of [
  ["the card is answered or dismissed", { pendingKey: null }],
  ["the modal opens", { compact: false }],
  ["the window hides", { visible: false }],
]) {
  test(`it stops for good when ${why}`, async (t) => {
    const view = await mountNudge(t, WAITING);
    await view.tick(1000);
    await view.render(change);
    assert.equal(view.nudge().cue, false);
    await view.render(WAITING);
    await view.tick(10_000);
    assert.deepEqual(view.opened, [], "never armed again for that card");
  });
}

test("starting on the card stops it", async (t) => {
  const view = await mountNudge(t, WAITING);
  await React.act(async () => view.nudge().cancel());
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

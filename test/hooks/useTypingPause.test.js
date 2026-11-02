const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const PAUSE = 500;

async function mountPause(t, initialArgs = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-typing-pause-" });
  const { useTypingPause } = await vite.ssrLoadModule("/hooks/useTypingPause.ts");
  let args = { typed: "", context: "a", held: false, ...initialArgs };
  let delay;
  function Harness() {
    delay = useTypingPause(args);
    return null;
  }
  root = createRoot(container);
  const render = async (next = {}) => {
    args = { ...args, ...next };
    await React.act(async () => root.render(React.createElement(Harness)));
  };
  await render();
  return { delay: () => delay, render };
}

test("a typed change waits, wherever it was typed", async (t) => {
  const pause = await mountPause(t);
  assert.equal(pause.delay(), 0, "nothing typed yet");
  await pause.render({ typed: "s" });
  assert.equal(pause.delay(), PAUSE, "the field is not focused here, but the key changed");
  await pause.render({ typed: "sk" });
  assert.equal(pause.delay(), PAUSE);
});

test("a tab, model or shown panel checks at once, even with a new key", async (t) => {
  const pause = await mountPause(t, { typed: "sk-one" });
  await pause.render({ typed: "sk-two", context: "b" });
  assert.equal(pause.delay(), 0, "a context change wins over a typed change in the same render");
});

test("leaving the fields sends at once, and focus alone starts no pause", async (t) => {
  const pause = await mountPause(t);
  await pause.render({ held: true });
  assert.equal(pause.delay(), PAUSE, "a focused field keeps the pause");
  await pause.render({ typed: "sk" });
  assert.equal(pause.delay(), PAUSE);
  await pause.render({ held: false });
  assert.equal(pause.delay(), 0, "the fields were left");
  await pause.render({ held: true });
  assert.equal(pause.delay(), PAUSE, "focus alone pauses only while it lasts");
  await pause.render({ held: false });
  assert.equal(pause.delay(), 0, "no typed change, so nothing waits");
});

test("a value saved on leaving the fields sends at once", async (t) => {
  const pause = await mountPause(t, { typed: "http://127.0.0.1:8080/v1/", held: true });
  // Leaving the address tidies and saves it in the same event as the hold's drop.
  await pause.render({ typed: "http://127.0.0.1:8080/v1", held: false });
  assert.equal(pause.delay(), 0, "the fields were left, so the save is not typing");
});

test("the pause outlives the field's focus until the check changes some other way", async (t) => {
  const pause = await mountPause(t);
  await pause.render({ typed: "sk" });
  assert.equal(pause.delay(), PAUSE);
  await pause.render({});
  await pause.render({});
  assert.equal(pause.delay(), PAUSE, "an unrelated rerender keeps the pause");
  await pause.render({ context: "b" });
  assert.equal(pause.delay(), 0, "a tab or model change checks at once");
});

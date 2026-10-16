const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const CONFIG = { scope: "transcription", provider: "groq", apiKey: "gsk-a", model: "m" };
const PASS = { success: true };
const REJECTED = { success: false, errorCode: "credentialsRejected", status: 401 };

async function mountCheck(t, initialProps = {}) {
  let root;
  // After hooks run in order: unmount and stop the mock clock before the server closes.
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    t.mock.timers.reset();
  });
  const requests = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        testProviderConnection: (config) =>
          new Promise((resolve, reject) => requests.push({ config, resolve, reject })),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-auto-check-" });
  const { useConnectionAutoCheck } = await vite.ssrLoadModule("/hooks/useConnectionAutoCheck.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let props = { config: CONFIG, ready: true, ...initialProps };
  let check;
  function Harness() {
    check = useConnectionAutoCheck(props);
    return null;
  }
  root = createRoot(container);
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await React.act(async () => root.render(React.createElement(Harness)));
  };
  await render();
  return {
    requests,
    state: () => check,
    render,
    edit: (apiKey) => render({ config: { ...props.config, apiKey } }),
    wait: (ms) => React.act(async () => t.mock.timers.tick(ms)),
    answer: (result, index = requests.length - 1) =>
      React.act(async () => requests[index].resolve(result)),
    fail: (index = requests.length - 1) =>
      React.act(async () => requests[index].reject(new Error("bridge failed"))),
    retry: () => React.act(async () => check.retry()),
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

test("a complete form spins at once and sends one request after the pause", async (t) => {
  const auto = await mountCheck(t);
  assert.equal(auto.state().phase, "waiting");
  await auto.wait(499);
  assert.equal(auto.requests.length, 0);
  await auto.wait(1);
  assert.deepEqual(
    auto.requests.map((request) => request.config),
    [CONFIG]
  );
  assert.equal(auto.state().phase, "checking");
  await auto.answer(PASS);
  assert.equal(auto.state().phase, "connected");
  assert.equal(auto.state().failure, null);
});

test("typing sends nothing until the typing pauses", async (t) => {
  const auto = await mountCheck(t, { config: { ...CONFIG, apiKey: "g" } });
  for (const apiKey of ["gs", "gsk", "gsk-", "gsk-a"]) {
    await auto.wait(300);
    await auto.edit(apiKey);
  }
  assert.equal(auto.requests.length, 0);
  await auto.wait(500);
  assert.deepEqual(
    auto.requests.map((request) => request.config.apiKey),
    ["gsk-a"]
  );
});

test("an answer for an earlier entry is discarded", async (t) => {
  const auto = await mountCheck(t);
  await auto.wait(500);
  await auto.edit("gsk-b");
  await auto.answer(PASS, 0);
  assert.equal(auto.state().phase, "waiting");
  await auto.wait(500);
  await auto.answer(REJECTED, 1);
  assert.equal(auto.state().phase, "failed");
  assert.equal(auto.state().failure.errorCode, "credentialsRejected");
});

test("a late answer for an earlier entry leaves the newer request alone", async (t) => {
  const auto = await mountCheck(t);
  await auto.wait(500);
  await auto.edit("gsk-b");
  await auto.wait(500);
  await auto.answer(PASS, 0);
  assert.equal(auto.state().phase, "checking");
  await auto.wait(2000);
  assert.equal(auto.requests.length, 2, "no second request for the current entry");
  await auto.answer(REJECTED, 1);
  assert.equal(auto.state().phase, "failed");
});

test("returning to an earlier value still checks again", async (t) => {
  const auto = await mountCheck(t);
  await auto.wait(500);
  await auto.answer(PASS);
  await auto.edit("gsk-b");
  await auto.edit("gsk-a");
  assert.equal(auto.state().phase, "waiting");
  await auto.wait(500);
  assert.equal(auto.requests.length, 2);
});

test("an incomplete form shows nothing and sends nothing", async (t) => {
  const auto = await mountCheck(t, { ready: false });
  await auto.wait(5000);
  assert.equal(auto.state().phase, "idle");
  assert.equal(auto.requests.length, 0);
});

test("a form completed later, as by a saved key arriving, is checked on arrival", async (t) => {
  const auto = await mountCheck(t, { ready: false });
  await auto.render({ ready: true });
  assert.equal(auto.state().phase, "waiting");
  await auto.wait(500);
  assert.equal(auto.requests.length, 1);
});

test("a hold sends nothing and shows nothing until it is released", async (t) => {
  const auto = await mountCheck(t, { hold: true });
  assert.equal(auto.state().phase, "idle");
  await auto.wait(5000);
  assert.equal(auto.requests.length, 0);
  await auto.render({ hold: false });
  assert.equal(auto.state().phase, "waiting");
  await auto.wait(500);
  assert.equal(auto.requests.length, 1);
});

test("a hold arriving during the pause cancels the pending request", async (t) => {
  const auto = await mountCheck(t);
  await auto.wait(300);
  await auto.render({ hold: true });
  await auto.wait(1000);
  assert.equal(auto.requests.length, 0);
  assert.equal(auto.state().phase, "idle");
});

test("a hold never undoes a result; only an edit does", async (t) => {
  const auto = await mountCheck(t);
  await auto.wait(500);
  await auto.answer(PASS);
  await auto.render({ hold: true });
  await auto.wait(5000);
  assert.equal(auto.state().phase, "connected");
  assert.equal(auto.requests.length, 1);
  await auto.edit("gsk-b");
  assert.equal(auto.state().phase, "idle");
});

test("a request already sent finishes under a hold", async (t) => {
  const auto = await mountCheck(t);
  await auto.wait(500);
  await auto.render({ hold: true });
  assert.equal(auto.state().phase, "checking");
  await auto.answer(PASS);
  assert.equal(auto.state().phase, "connected");
});

test("retry runs the same check again at once", async (t) => {
  const auto = await mountCheck(t);
  await auto.wait(500);
  await auto.answer(REJECTED);
  assert.equal(auto.state().announcement, null, "a failure speaks through its alert");
  await auto.retry();
  assert.equal(auto.state().phase, "checking");
  assert.deepEqual(auto.requests[1].config, CONFIG);
  await auto.answer(PASS);
  assert.equal(auto.state().phase, "connected");
});

test("a missing or failing bridge reads as a failed check", async (t) => {
  await t.test("missing", async (t) => {
    const auto = await mountCheck(t);
    delete globalThis.window.electronAPI.testProviderConnection; // lint: no bare `window`
    await auto.wait(500);
    assert.equal(auto.state().phase, "failed");
    assert.deepEqual(auto.state().failure, { success: false });
  });
  await t.test("rejected", async (t) => {
    const auto = await mountCheck(t);
    await auto.wait(500);
    await auto.fail();
    assert.equal(auto.state().phase, "failed");
  });
});

test("Testing… is announced only for a request still running after a second", async (t) => {
  const auto = await mountCheck(t);
  await auto.wait(500);
  await auto.wait(999);
  assert.equal(auto.state().announcement, null);
  await auto.wait(1);
  assert.equal(auto.state().announcement, "testing");
  await auto.answer(PASS);
  assert.equal(auto.state().announcement, "connected");
});

test("a quick check announces only its result, and an edit clears it", async (t) => {
  const auto = await mountCheck(t);
  await auto.wait(800);
  await auto.answer(PASS);
  assert.equal(auto.state().announcement, "connected");
  await auto.edit("gsk-b");
  assert.equal(auto.state().announcement, null);
});

test("unmounting cancels the pending request", async (t) => {
  const auto = await mountCheck(t);
  await auto.unmount();
  await auto.wait(1000);
  assert.equal(auto.requests.length, 0);
});

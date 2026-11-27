const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installHappyDom,
  addTeardown,
} = require("../lib/rendererTestHarness");

async function mountOption(t, getSttConfig) {
  const React = require("react");
  let root;
  addTeardown(t, async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const window = await installHappyDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t);
  const { FourierPilotOption } = await vite.ssrLoadModule(
    "/components/settings/FourierPilotOption.tsx"
  );
  const { PanelVisibleProvider } = await vite.ssrLoadModule("/components/ui/usePanelVisible.ts");
  root = createRoot(window.document.body.appendChild(window.document.createElement("div")));
  window.electronAPI = { getSttConfig };
  const render = (account, visible = true) =>
    React.act(async () =>
      root.render(
        React.createElement(
          PanelVisibleProvider,
          { value: visible },
          React.createElement(FourierPilotOption, { key: account, account })
        )
      )
    );
  const toggle = () => window.document.querySelector('[aria-label="Fourier 2B"][role="switch"]');
  return { React, window, render, toggle };
}

const eligible = {
  success: true,
  optionalBatchModelAccount: "pilot",
  optionalBatchModels: [{ id: "oruk-fourier-2b", languages: ["en"] }],
};

test("an enrolled user can enable and disable the Fourier switch; another account never sees it", async (t) => {
  const { React, window, render, toggle } = await mountOption(t, async () => eligible);
  await render("pilot");
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  await React.act(async () => toggle().click());
  assert.equal(window.localStorage.getItem("openwhispr:fourier-english:pilot"), "1");
  await render("other");
  assert.equal(toggle(), null);
  await render("pilot");
  assert.equal(toggle().getAttribute("aria-checked"), "true");
  await React.act(async () => toggle().click());
  assert.equal(window.localStorage.getItem("openwhispr:fourier-english:pilot"), null);
});

test("revoking enrollment hides an enabled Fourier switch while Settings stays open", async (t) => {
  let config = eligible;
  const getSttConfig = t.mock.fn(async () => config);
  const { React, window, render, toggle } = await mountOption(t, getSttConfig);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await render("pilot");
  await React.act(async () => toggle().click());
  assert.equal(toggle().getAttribute("aria-checked"), "true");

  config = { success: true };
  await React.act(async () => t.mock.timers.tick(30_000));
  assert.equal(toggle(), null);
  assert.equal(window.localStorage.getItem("openwhispr:fourier-english:pilot"), "1");

  await React.act(async () => t.mock.timers.tick(30_000));
  assert.equal(getSttConfig.mock.callCount(), 2);
});

test("a hidden dictation tab waits until shown and ignores its previous enrollment response", async (t) => {
  const pending = Promise.withResolvers();
  const getSttConfig = t.mock.fn(async () => ({ success: true }));
  getSttConfig.mock.mockImplementationOnce(() => pending.promise);
  const { React, render, toggle } = await mountOption(t, getSttConfig);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  await render("pilot");
  await render("pilot", false);
  await React.act(async () => t.mock.timers.tick(30_000));
  assert.equal(getSttConfig.mock.callCount(), 1);
  await render("pilot");
  assert.equal(getSttConfig.mock.callCount(), 2);

  await React.act(async () => pending.resolve(eligible));
  assert.equal(toggle(), null);
  await React.act(async () => t.mock.timers.tick(30_000));
  assert.equal(getSttConfig.mock.callCount(), 2);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installHappyDom,
  addTeardown,
} = require("../lib/rendererTestHarness");

test("an enrolled user can enable and disable the Fourier switch; another account never sees it", async (t) => {
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
  root = createRoot(window.document.body.appendChild(window.document.createElement("div")));
  window.electronAPI = {
    getSttConfig: async () => ({
      success: true,
      optionalBatchModelAccount: "pilot",
      optionalBatchModels: [{ id: "oruk-fourier-2b", languages: ["en"] }],
    }),
  };
  const render = (account) =>
    React.act(async () =>
      root.render(React.createElement(FourierPilotOption, { key: account, account }))
    );
  const toggle = () => window.document.querySelector('[aria-label="Fourier 2B"][role="switch"]');
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

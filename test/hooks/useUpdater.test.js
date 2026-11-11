const assert = require("node:assert/strict");
const test = require("node:test");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

test("only a policy refusal turns a download result into an error", async (t) => {
  const results = [];
  installBrowserGlobals(t, {
    window: { electronAPI: { downloadUpdate: async () => results.shift() } },
  });
  const { useUpdater } = await import("../../src/hooks/useUpdater.ts");
  let updater;
  function Probe() {
    updater = useUpdater();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));

  const unsupported = {
    success: false,
    message: "Updates are installed through the system package manager",
  };
  results.push(unsupported);
  assert.deepEqual(await updater.downloadUpdate(), unsupported);

  results.push({
    success: false,
    code: "UPDATES_MANAGED_BY_ORG",
    message: "Your organization manages updates.",
  });
  await assert.rejects(updater.downloadUpdate(), { code: "UPDATES_MANAGED_BY_ORG" });
});

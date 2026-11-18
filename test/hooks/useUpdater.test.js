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

test("the update info a policy block cleared comes back once updates are allowed", async (t) => {
  const React = require("react");
  const { installHappyDom } = require("../lib/happyDomDialog");
  const { happyWindow, createRoot } = await installHappyDom();
  const status = {
    updateAvailable: false,
    updateDownloaded: true,
    updateMode: "user_choice",
    isDevelopment: false,
    isSupported: true,
  };
  let onStatus;
  happyWindow.electronAPI = {
    getUpdateStatus: async () => status,
    getUpdateInfo: async () => ({ version: "99.0.0" }),
    onUpdateStatusChanged: (callback) => {
      onStatus = callback;
      return () => {};
    },
  };
  const { useUpdater } = await import("../../src/hooks/useUpdater.ts");
  let updater;
  function Probe() {
    updater = useUpdater();
    return null;
  }
  const root = createRoot(happyWindow.document.createElement("div"));
  t.after(async () => {
    await React.act(async () => root.unmount());
    await happyWindow.happyDOM.close();
  });
  await React.act(async () => root.render(createElement(Probe)));
  assert.equal(updater.info?.version, "99.0.0");

  await React.act(async () => onStatus({ ...status, updateMode: "it_managed" }));
  assert.equal(updater.info, null);
  await React.act(async () => onStatus(status));
  assert.equal(updater.info?.version, "99.0.0");
});

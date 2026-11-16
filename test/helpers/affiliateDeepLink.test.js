const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
function loadMain(platform, argv = []) {
  const calls = [];
  const manager = {
    controlPanelWindow: null,
    createMainWindow: async () => {},
    createControlPanelWindow: async () => {
      calls.push("create");
      manager.controlPanelWindow = { webContents: { send: (event) => calls.push(event) } };
    },
    showControlPanel: () => calls.push("show"),
  };
  const context = vm.createContext({
    windowManager: manager,
    pendingAffiliateDeepLink: false,
    affiliateWindowReady: false,
    require: () => ({ capture: () => true }),
    OAUTH_PROTOCOL: "openwhispr",
    isLiveWindow: (window) => !!window,
    debugLogger: { error: (message) => assert.fail(message), info() {} },
    environmentManager: { getStartMinimized: () => true },
    wasLaunchedAtLoginHidden: () => false,
    process: { platform, argv },
    checkStartupHold: async () => {},
    flushPendingNoteDeepLink: async () => {},
    handleEnterpriseAudioLink: () => false,
    isNoteDeepLink: () => false,
  });
  for (const name of ["flushPendingAffiliateDeepLink", "handleAffiliateDeepLink"]) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    if (start !== -1)
      vm.runInContext(source.slice(start, source.indexOf("\n}\n", start) + 2), context);
  }
  const startup = source.slice(
    source.indexOf("  const launchedHidden = wasLaunchedAtLoginHidden();"),
    source.indexOf("  await hotkeyManager.hyprlandRegistrationReady;")
  );
  return {
    calls,
    manager,
    context,
    arrive: () =>
      vm.runInContext("handleAffiliateDeepLink('openwhispr://affiliate?dub_id=click')", context),
    start: async () => {
      await vm.runInContext(`(async () => { ${startup} })()`, context);
      await new Promise(setImmediate);
    },
  };
}

for (const platform of ["win32", "linux"]) {
  test(`a ${platform} creator-link launch opens the panel despite Start minimized`, async () => {
    const main = loadMain(platform, ["app", "openwhispr://affiliate?dub_id=click"]);
    await main.start();
    assert.ok(main.calls.includes("create"));
    assert.ok(main.calls.includes("show"));
    assert.ok(main.calls.includes("affiliate-link"));
  });
}

test("a cold macOS creator link waits for window initialization then opens the panel", async () => {
  const main = loadMain("darwin");
  main.context.windowManager = null;
  assert.equal(main.arrive(), true);
  assert.deepEqual(main.calls, []);
  main.context.windowManager = main.manager;
  await main.start();
  assert.ok(main.calls.includes("create"));
  assert.ok(main.calls.includes("show"));
});

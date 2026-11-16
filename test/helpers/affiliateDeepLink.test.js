const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");

const source = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
function loadMain(t, platform, argv = [], { enabled = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "affiliate-launch-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = {
    OPENWHISPR_AFFILIATE_ENABLED: String(enabled),
    OPENWHISPR_AFFILIATE_DOMAIN: "try.openwhispr.com",
  };
  const affiliateModule = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../../src/helpers/affiliateLinks.js"), "utf8"),
    {
      module: affiliateModule,
      process: { env: environment },
      URL,
      require(name) {
        if (name === "electron") return { app: { getPath: () => directory }, net: {} };
        if (name === "./tokenStore") return { getState: () => ({ token: null, generation: 0 }) };
        if (name === "./accountScopeBinding")
          return { read: () => null, resolveActiveAccountScope: () => null };
        return require(name);
      },
    }
  );
  const affiliateLinks = affiliateModule.exports;
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
    pendingAffiliateDeepLinks: [],
    affiliateWindowReady: false,
    require: () => affiliateLinks,
    URL,
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
    candidate: () => affiliateLinks.candidateForCurrentAccount(),
    enable: () => {
      environment.OPENWHISPR_AFFILIATE_ENABLED = "true";
    },
    arrive: (url = "openwhispr://affiliate?dub_id=click") => context.handleAffiliateDeepLink(url),
    start: async () => {
      await vm.runInContext(`(async () => { ${startup} })()`, context);
      await new Promise(setImmediate);
    },
  };
}

for (const platform of ["win32", "linux"]) {
  test(`a ${platform} creator-link launch opens the panel despite Start minimized`, async (t) => {
    const main = loadMain(t, platform, ["app", "openwhispr://affiliate?dub_id=click"]);
    await main.start();
    assert.ok(main.calls.includes("create"));
    assert.ok(main.calls.includes("show"));
    assert.ok(main.calls.includes("affiliate-link"));
  });
}

test("a cold macOS creator link waits for window initialization then opens the panel", async (t) => {
  const main = loadMain(t, "darwin");
  main.context.windowManager = null;
  assert.equal(main.arrive(), true);
  assert.deepEqual(main.calls, []);
  main.context.windowManager = main.manager;
  await main.start();
  assert.ok(main.calls.includes("create"));
  assert.ok(main.calls.includes("show"));
});

test("a cold macOS creator link survives configuration loading after open-url", async (t) => {
  const main = loadMain(t, "darwin", [], { enabled: false });
  main.context.windowManager = null;
  const link = "https://try.openwhispr.com/creator";
  assert.equal(main.arrive(`openwhispr://affiliate?link=${encodeURIComponent(link)}`), true);
  assert.equal(main.candidate(), null);
  assert.deepEqual(main.calls, []);

  main.enable();
  main.context.windowManager = main.manager;
  await main.start();
  assert.equal(main.candidate().link, link);
  assert.ok(main.calls.includes("affiliate-link"));
});

test("a queued creator link stays inactive when the loaded configuration is disabled", async (t) => {
  const main = loadMain(t, "darwin", [], { enabled: false });
  main.arrive();
  await main.start();
  assert.equal(main.candidate(), null);
  assert.deepEqual(main.calls, []);
});

test("a queued creator link is validated against the loaded domain", async (t) => {
  const main = loadMain(t, "darwin", [], { enabled: false });
  main.arrive("openwhispr://affiliate?link=https%3A%2F%2Fevil.test%2Fcreator");
  main.enable();
  await main.start();
  assert.equal(main.candidate(), null);
  assert.deepEqual(main.calls, []);
});

test("warm creator links still save and open the panel", async (t) => {
  const main = loadMain(t, "darwin");
  await main.start();
  assert.equal(main.arrive(), true);
  await new Promise(setImmediate);
  assert.equal(main.candidate().clickId, "click");
  assert.ok(main.calls.includes("affiliate-link"));
});

test("non-affiliate links remain available to their existing handlers", async (t) => {
  const main = loadMain(t, "darwin");
  for (const url of [
    "openwhispr://auth?bearer_token=test",
    "openwhispr://notes/test",
    "openwhispr://invitations/test",
    "other://affiliate?dub_id=click",
  ])
    assert.equal(main.arrive(url), false);
  await main.start();
  assert.deepEqual(main.calls, []);
});

for (const rejectedLink of [
  "https://evil.test/creator",
  "https://open-whispr-affiliate-sandbox.dub.link/creator",
]) {
  test(`a later cold arrival from ${rejectedLink} cannot erase a valid creator link`, async (t) => {
    const main = loadMain(t, "darwin", [], { enabled: false });
    const link = "https://try.openwhispr.com/creator";
    main.arrive(`openwhispr://affiliate?link=${encodeURIComponent(link)}`);
    main.arrive(`openwhispr://affiliate?link=${encodeURIComponent(rejectedLink)}`);
    main.enable();
    await main.start();
    assert.equal(main.candidate()?.link, link);
    assert.equal(main.calls.filter((call) => call === "affiliate-link").length, 1);
  });
}

test("multiple cold creator links retain the latest valid arrival", async (t) => {
  const main = loadMain(t, "darwin", [], { enabled: false });
  main.arrive("openwhispr://affiliate?dub_id=first");
  main.arrive("openwhispr://affiliate?dub_id=second");
  main.enable();
  await main.start();
  assert.equal(main.candidate()?.clickId, "second");
  assert.equal(main.calls.filter((call) => call === "affiliate-link").length, 1);
});

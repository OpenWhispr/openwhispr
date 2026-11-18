const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const base = {
  isSignedIn: false,
  calendarConnected: false,
  cloudBackupEnabled: false,
  webSearchEnabled: true,
  productHelpEnabled: false,
};

async function load(t, electronAPI = {}) {
  installBrowserGlobals(t, { window: { electronAPI } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-web-search-reg-test-" });
  const { createToolRegistry } = await vite.ssrLoadModule("/services/tools/index.ts");
  const { resolveUnavailableCapabilities } = await vite.ssrLoadModule(
    "/config/agentCapabilities.ts"
  );
  return { createToolRegistry, resolveUnavailableCapabilities, vite };
}

test("web_search follows webSearchSignedIn, not the OpenWhispr cloud isSignedIn", async (t) => {
  const { createToolRegistry } = await load(t);

  const signedInViaTitanium = createToolRegistry({
    ...base,
    isSignedIn: false,
    webSearchSignedIn: true,
  });
  assert.ok(signedInViaTitanium.get("web_search"));

  const signedOut = createToolRegistry({ ...base, isSignedIn: true, webSearchSignedIn: false });
  assert.equal(signedOut.get("web_search"), undefined, "cloud isSignedIn is ignored for this tool");
});

test("web_search keeps following isSignedIn when webSearchSignedIn is not passed", async (t) => {
  const { createToolRegistry } = await load(t);
  assert.ok(createToolRegistry({ ...base, isSignedIn: true }).get("web_search"));
  assert.equal(createToolRegistry({ ...base, isSignedIn: false }).get("web_search"), undefined);
});

test("policy still switches web_search off for a signed-in user", async (t) => {
  const { createToolRegistry } = await load(t);
  const registry = createToolRegistry({
    ...base,
    webSearchSignedIn: true,
    webSearchEnabled: false,
  });
  assert.equal(registry.get("web_search"), undefined);
});

test("the web search capability reads webSearch.signedIn when given", async (t) => {
  const { resolveUnavailableCapabilities } = await load(t);
  const input = (webSearch, isSignedIn) => ({
    supportsTools: true,
    isSignedIn,
    webSearch,
    calendarConnected: true,
    locations: {
      account: "a",
      plans: "p",
      calendars: "c",
      connectors: "k",
      models: "m",
    },
  });
  const names = (list) => list.map((item) => item.name);

  assert.deepEqual(
    names(
      resolveUnavailableCapabilities(
        input({ allowed: true, blockedByOrg: false, signedIn: true }, false)
      )
    ).filter((n) => n === "Web search"),
    [],
    "Titanium signed in: web search is not reported unavailable"
  );
  assert.ok(
    names(
      resolveUnavailableCapabilities(
        input({ allowed: true, blockedByOrg: false, signedIn: false }, true)
      )
    ).includes("Web search"),
    "Titanium signed out: reported unavailable even with a cloud session"
  );
  assert.ok(
    names(
      resolveUnavailableCapabilities(input({ allowed: true, blockedByOrg: false }, false))
    ).includes("Web search"),
    "without signedIn the old isSignedIn rule applies"
  );
});

test("the web_search tool reports a refused search as a failure, not as data", async (t) => {
  const { createToolRegistry } = await load(t, {
    agentWebSearch: async () => ({
      success: false,
      code: "AUTH_REQUIRED",
      error: "Sign in to use web search",
    }),
  });
  const tool = createToolRegistry({ ...base, webSearchSignedIn: true }).get("web_search");
  const out = await tool.execute({ query: "cats" });
  assert.equal(out.success, false);
  assert.match(out.displayText, /Sign in to use web search/);
});

test("the web_search tool still maps results unchanged", async (t) => {
  const { createToolRegistry } = await load(t, {
    agentWebSearch: async () => ({
      success: true,
      results: [{ title: "T", url: "https://e.test", text: "body", publishedDate: "2026-01-01" }],
    }),
  });
  const tool = createToolRegistry({ ...base, webSearchSignedIn: true }).get("web_search");
  const out = await tool.execute({ query: "cats" });
  assert.equal(out.success, true);
  assert.deepEqual(out.data, [
    { title: "T", url: "https://e.test", text: "body", publishedDate: "2026-01-01" },
  ]);
});

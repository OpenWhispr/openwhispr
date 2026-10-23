const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
const { managedPolicy } = require("../helpers/harness/policyFixtures");

// The main process sweeps on the periods each sync carries, so this pins what the
// renderer sends. SSR cannot run useEffect, so the settings provider is mounted for real.
async function mountSettings(t, initialStorage) {
  // Registered before the browser globals so it runs before their teardown.
  const rootRef = { current: null };
  t.after(async () => {
    if (rootRef.current) await React.act(async () => rootRef.current.unmount());
  });

  const syncs = [];
  const known = {
    syncRetentionSettings: (settings) => {
      syncs.push(settings);
    },
    // Startup seeds the agent name into the dictionary. Left pending, the write
    // never reaches its cloud push, which imports a module after teardown.
    applyDictionaryChanges: () => new Promise(() => {}),
  };
  // Every other bridge call the provider makes is irrelevant here.
  const electronAPI = new Proxy(known, {
    get: (target, name) =>
      name in target
        ? target[name]
        : String(name).startsWith("on")
          ? () => () => {}
          : async () => undefined,
  });

  installBrowserGlobals(t, { initialStorage, window: { electronAPI } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-retention-settings-sync-test-",
  });
  const [{ SettingsProvider }, { useSettingsStore }, { usePolicyStore }] = await Promise.all([
    vite.ssrLoadModule("/hooks/useSettings.ts"),
    vite.ssrLoadModule("/stores/settingsStore.ts"),
    vite.ssrLoadModule("/stores/policyStore.ts"),
  ]);

  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(SettingsProvider, null, null)));
  rootRef.current = root;

  return { syncs, useSettingsStore, usePolicyStore };
}

test("the main process is told the chat and meeting transcript periods", async (t) => {
  const { syncs } = await mountSettings(t, {
    chatRetentionDays: "14",
    meetingTranscriptRetentionDays: "60",
  });

  assert.equal(syncs.at(-1).chatRetentionDays, 14);
  assert.equal(syncs.at(-1).meetingTranscriptRetentionDays, 60);
});

test("changing a chat or meeting transcript period syncs it again", async (t) => {
  const { syncs, useSettingsStore } = await mountSettings(t, {});

  await React.act(async () => useSettingsStore.getState().setChatRetentionDays(7));
  assert.equal(syncs.at(-1).chatRetentionDays, 7);

  await React.act(async () => useSettingsStore.getState().setMeetingTranscriptRetentionDays(30));
  assert.equal(syncs.at(-1).meetingTranscriptRetentionDays, 30);
});

test("a workspace that always keeps history keeps chats and transcripts forever", async (t) => {
  const { syncs, usePolicyStore } = await mountSettings(t, {
    chatRetentionDays: "14",
    meetingTranscriptRetentionDays: "60",
  });
  const policy = managedPolicy();
  policy.dataRetention.localHistoryMode = "always_on";

  await React.act(async () =>
    usePolicyStore.setState({ status: "managed", appVersion: "1.10.0", policy })
  );

  assert.equal(syncs.at(-1).chatRetentionDays, 0);
  assert.equal(syncs.at(-1).meetingTranscriptRetentionDays, 0);
});

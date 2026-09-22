const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("initial notification snapshot is atomic and precedes secret hydration", async (t) => {
  const snapshots = [];
  let releaseSecrets;
  const secrets = new Promise((resolve) => {
    releaseSecrets = resolve;
  });
  installBrowserGlobals(t, {
    initialStorage: {
      notificationsEnabled: "false",
      notifyMeetingDetection: "true",
      notifyCalendarReminders: "false",
      meetingProcessDetection: "false",
      customDictionary: '["OpenWhispr"]',
    },
    window: {
      electronAPI: {
        getOpenAIKey: () => secrets,
        setDictionary: async () => {},
        syncNotificationPreferences: async (prefs) => {
          snapshots.push(prefs);
        },
        meetingDetectionSetPreferences: () => {
          assert.fail("startup must send one atomic snapshot");
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-notification-preferences-test-",
  });
  const { initializeSettings } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const initialization = initializeSettings();
  try {
    await Promise.resolve();
    assert.deepEqual(snapshots, [
      {
        notificationsEnabled: false,
        notifyMeetingDetection: true,
        notifyCalendarReminders: false,
        meetingProcessDetection: false,
      },
    ]);
  } finally {
    releaseSecrets("");
    await initialization;
    const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
    await i18n.changeLanguage("en");
  }
  assert.equal(snapshots.length, 1);
});

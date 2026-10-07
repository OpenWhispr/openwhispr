const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("startup syncs the full saved notification snapshot once", async (t) => {
  const snapshots = [];
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
        getOpenAIKey: async () => "",
        setDictionary: async () => {},
        syncNotificationPreferences: async (prefs) => {
          snapshots.push(prefs);
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-notification-preferences-test-",
  });
  const { initializeSettings } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  try {
    await initializeSettings();
  } finally {
    const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
    await i18n.changeLanguage("en");
  }
  assert.deepEqual(snapshots, [
    {
      notificationsEnabled: false,
      notifyMeetingDetection: true,
      notifyCalendarReminders: false,
      meetingProcessDetection: false,
    },
  ]);
});

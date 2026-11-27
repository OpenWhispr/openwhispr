const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function startSettings(
  t,
  { initialStorage = {}, syncNotificationPreferences = async () => {}, storageListeners = [] }
) {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { customDictionary: '["OpenWhispr"]', ...initialStorage },
    window: {
      addEventListener(type, listener) {
        if (type === "storage") storageListeners.push(listener);
      },
      electronAPI: {
        getOpenAIKey: async () => "",
        setDictionary: async () => {},
        syncNotificationPreferences,
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-notification-preferences-test-",
  });
  const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  try {
    await initializeSettings();
  } finally {
    const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
    await i18n.changeLanguage("en");
  }
  return { storage, useSettingsStore };
}

test("startup syncs the full saved notification snapshot once", async (t) => {
  const snapshots = [];
  await startSettings(t, {
    initialStorage: {
      notificationsEnabled: "false",
      notifyMeetingDetection: "true",
      notifyCalendarReminders: "false",
      meetingProcessDetection: "false",
      meetingDetectionIgnoredApps: '[{"id":"orca.exe","name":"Orca"}]',
    },
    syncNotificationPreferences: async (prefs) => {
      snapshots.push(prefs);
    },
  });
  assert.deepEqual(snapshots, [
    {
      notificationsEnabled: false,
      notifyMeetingDetection: true,
      notifyCalendarReminders: false,
      meetingProcessDetection: false,
      meetingDetectionIgnoredApps: [{ id: "orca.exe", name: "Orca" }],
    },
  ]);
});

test("apps ignored from another window arrive as a list", async (t) => {
  const storageListeners = [];
  const { storage, useSettingsStore } = await startSettings(t, { storageListeners });
  const apps = [{ id: "orca.exe", name: "Orca" }];
  storageListeners.forEach((listener) =>
    listener({
      key: "meetingDetectionIgnoredApps",
      newValue: JSON.stringify(apps),
      storageArea: storage,
    })
  );
  assert.deepEqual(useSettingsStore.getState().meetingDetectionIgnoredApps, apps);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("analytics uploads reconcile the account participation before reading rows", async (t) => {
  t.mock.method(console, "error", () => {});
  t.after(() => {
    for (const key of [
      "__analyticsParticipation",
      "__analyticsParticipationRead",
      "__analyticsLocalConsent",
      "__analyticsSettingsWrites",
      "__analyticsUploadAllowed",
    ]) {
      delete globalThis[key];
    }
  });

  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      dataRetentionEnabled: "true",
      insightsSyncEnabled: "true",
      isSignedIn: "true",
    },
  });
  globalThis.__analyticsParticipation = { configured: true, enabled: true, updatedAt: null };
  globalThis.__analyticsParticipationRead = async () => globalThis.__analyticsParticipation;
  globalThis.__analyticsLocalConsent = true;
  globalThis.__analyticsSettingsWrites = [];
  globalThis.__analyticsUploadAllowed = [];

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-analytics-participation-gate-",
    mockModules: {
      "/services/NotesService.js": "export const NotesService = {};",
      "/services/ConversationsService.js": "export const ConversationsService = {};",
      "/services/FoldersService.js": "export const FoldersService = {};",
      "/services/SpacesService.js": "export const SpacesService = {};",
      "/services/TranscriptionsService.js": "export const TranscriptionsService = {};",
      "/services/DictionaryService.js": "export const DictionaryService = {};",
      "/services/SnippetService.js": "export const SnippetService = {};",
      "./AnalyticsService.js": `
        export const syncPendingAnalytics = async ({ uploadAllowed }) => {
          const allowed = typeof uploadAllowed === "function"
            ? await uploadAllowed()
            : uploadAllowed;
          globalThis.__analyticsUploadAllowed.push(allowed);
          return allowed ? 1 : 0;
        };
      `,
      "./LeaderboardService": `
        export const LeaderboardService = {
          flushPendingLeave: async () => false,
          getParticipation: () => globalThis.__analyticsParticipationRead()
        };
      `,
      "./cloudApi.js": `
        export class CloudApiError extends Error {}
        export const isAuthContextError = () => false;
      `,
      "/lib/authRequestContext": `
        export const assertAuthGenerationCurrent = () => {};
        export const getAuthRequestContextSnapshot = () => ({ sessionUserId: "user_1" });
        export const getValidatedAuthGeneration = () => 7;
        export const hasValidatedAuthContext = () => true;
      `,
      "/lib/teamSpacesCapability": `
        export const clearTeamSpacesCapability = () => {};
        export const readTeamSpacesCapability = () => false;
        export const writeTeamSpacesCapability = () => {};
      `,
      "/lib/subscriptionFlag": `
        export const readIsSubscribed = () => false;
        export const subscribeIsSubscribed = () => () => {};
      `,
      "/lib/noteConflictRegistry": "export const readNoteConflictIds = () => [];",
      "/stores/policyRules": `
        export const cloudBackupResumed = () => false;
        export const effectiveLocalHistoryEnabled = (_state, enabled) => enabled;
        export const isCloudBackupAllowed = () => true;
      `,
      "/stores/policyStore": `
        export const usePolicyStore = {
          getState: () => ({}),
          subscribe: () => () => {}
        };
      `,
      "/stores/settingsStore": `
        export const useSettingsStore = {
          getState: () => ({
            setInsightsSyncEnabled: (enabled) => {
              globalThis.__analyticsSettingsWrites.push(enabled);
              globalThis.__analyticsLocalConsent = enabled;
              localStorage.setItem("insightsSyncEnabled", String(enabled));
            }
          })
        };
      `,
    },
  });
  const { SyncService } = await vite.ssrLoadModule("/services/SyncService.ts");
  const service = new SyncService();
  service.consent = () => ({
    analytics: globalThis.__analyticsLocalConsent,
    backup: false,
    shared: true,
  });

  assert.equal(await service.syncAnalyticsNow(), true);
  assert.deepEqual(globalThis.__analyticsUploadAllowed, [true]);

  storage.setItem("insightsSyncEnabled", "true");
  globalThis.__analyticsLocalConsent = true;
  globalThis.__analyticsParticipation = { configured: true, enabled: false, updatedAt: null };
  assert.equal(await service.syncAnalyticsNow(), false);
  assert.deepEqual(globalThis.__analyticsSettingsWrites, [false]);
  assert.deepEqual(globalThis.__analyticsUploadAllowed, [true, false]);

  storage.setItem("insightsSyncEnabled", "true");
  globalThis.__analyticsLocalConsent = true;
  globalThis.__analyticsParticipation = { configured: false, enabled: false, updatedAt: null };
  assert.equal(await service.syncAnalyticsNow(), true);
  assert.deepEqual(
    globalThis.__analyticsUploadAllowed,
    [true, false, true],
    "legacy Insights consent survives until the account chooses a leaderboard state"
  );

  storage.setItem("insightsSyncEnabled", "true");
  globalThis.__analyticsLocalConsent = true;
  let releaseParticipation;
  globalThis.__analyticsParticipationRead = () =>
    new Promise((resolve) => {
      releaseParticipation = resolve;
    });
  const inFlight = service.syncAnalyticsNow();
  while (typeof releaseParticipation !== "function") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  storage.setItem("insightsSyncEnabled", "false");
  globalThis.__analyticsLocalConsent = false;
  releaseParticipation({ configured: true, enabled: true, updatedAt: null });
  assert.equal(await inFlight, false);
  assert.equal(
    globalThis.__analyticsUploadAllowed.at(-1),
    false,
    "a local opt-out during the participation read wins before rows are uploaded"
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("analytics uploads depend on Sync consent, not leaderboard participation", async (t) => {
  t.mock.method(console, "error", () => {});
  t.after(() => {
    for (const key of [
      "__analyticsBeforeUpload",
      "__analyticsFlushes",
      "__analyticsLocalConsent",
      "__analyticsParticipationReads",
      "__analyticsSyncContexts",
      "__analyticsSyncFailure",
      "__analyticsUploadAllowed",
    ]) {
      delete globalThis[key];
    }
  });

  installBrowserGlobals(t, {
    initialStorage: {
      dataRetentionEnabled: "true",
      insightsSyncEnabled: "true",
      isSignedIn: "true",
    },
  });
  globalThis.__analyticsBeforeUpload = null;
  globalThis.__analyticsFlushes = 0;
  globalThis.__analyticsLocalConsent = true;
  globalThis.__analyticsParticipationReads = 0;
  globalThis.__analyticsSyncContexts = [];
  globalThis.__analyticsSyncFailure = false;
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
        export const syncPendingAnalytics = async ({ uploadAllowed, context }) => {
          await globalThis.__analyticsBeforeUpload;
          globalThis.__analyticsSyncContexts.push(context);
          if (globalThis.__analyticsSyncFailure) throw new Error("upload failed");
          const allowed = typeof uploadAllowed === "function"
            ? await uploadAllowed()
            : uploadAllowed;
          globalThis.__analyticsUploadAllowed.push(allowed);
          return allowed ? 1 : 0;
        };
      `,
      "./LeaderboardService": `
        export const LeaderboardService = {
          flushPendingLeave: async () => {
            globalThis.__analyticsFlushes += 1;
            return false;
          },
          getParticipation: () => {
            globalThis.__analyticsParticipationReads += 1;
            throw new Error("analytics sync must not read participation");
          }
        };
      `,
      "./cloudApi.js": `
        export class CloudApiError extends Error {}
        export const isAuthContextError = () => false;
      `,
      "/lib/authRequestContext": `
        export const assertAuthGenerationCurrent = () => {};
        export const getAuthRequestContextSnapshot = () => ({
          sessionUserId: "user_1",
          sessionGeneration: 7,
          validatedGeneration: 7
        });
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
  assert.deepEqual(globalThis.__analyticsSyncContexts, [
    { accountId: "user_1", authGeneration: 7 },
  ]);
  assert.equal(globalThis.__analyticsParticipationReads, 0);
  assert.equal(globalThis.__analyticsFlushes, 1, "a durable pending leave is still retried");

  let releaseUpload;
  globalThis.__analyticsBeforeUpload = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const inFlight = service.syncAnalyticsNow();
  globalThis.__analyticsLocalConsent = false;
  releaseUpload();
  assert.equal(await inFlight, false);
  assert.equal(
    globalThis.__analyticsUploadAllowed.at(-1),
    false,
    "a local opt-out during a pass wins before rows are uploaded"
  );
  assert.equal(globalThis.__analyticsParticipationReads, 0);

  globalThis.__analyticsBeforeUpload = null;
  globalThis.__analyticsLocalConsent = true;
  globalThis.__analyticsSyncFailure = true;
  assert.equal(
    await service.syncAnalyticsNow(),
    false,
    "a failed foreground upload must not be reported as synchronized"
  );
});

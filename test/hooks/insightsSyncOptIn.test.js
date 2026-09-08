const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("the combined opt-in reports claim failures before enabling sync or joining", async (t) => {
  let root = null;
  let hook;
  t.mock.method(console, "error", () => {});
  t.after(() => {
    for (const key of [
      "__insightsClaimAccepted",
      "__insightsClaimCalls",
      "__insightsClaimMode",
      "__insightsConsentRequests",
      "__insightsAuthGeneration",
      "__insightsJoinCalls",
      "__insightsJoinMode",
      "__insightsParticipationRefreshes",
      "__insightsParticipationResets",
      "__insightsQueuedLeaves",
      "__insightsSessionUserId",
      "__insightsAwaitingUploadCount",
      "__insightsUnclaimedCount",
      "__insightsSetEnabledValues",
      "__insightsSyncEnabled",
      "__insightsSyncRequests",
      "__insightsToasts",
    ]) {
      delete globalThis[key];
    }
  });

  globalThis.__insightsClaimAccepted = true;
  globalThis.__insightsClaimCalls = 0;
  globalThis.__insightsClaimMode = "failure";
  globalThis.__insightsConsentRequests = 0;
  globalThis.__insightsAuthGeneration = 7;
  globalThis.__insightsJoinCalls = 0;
  globalThis.__insightsJoinMode = "success";
  globalThis.__insightsParticipationRefreshes = 0;
  globalThis.__insightsParticipationResets = 0;
  globalThis.__insightsQueuedLeaves = [];
  globalThis.__insightsSessionUserId = "account-1";
  globalThis.__insightsAwaitingUploadCount = 1;
  globalThis.__insightsUnclaimedCount = 1;
  globalThis.__insightsSetEnabledValues = [];
  globalThis.__insightsSyncEnabled = false;
  globalThis.__insightsSyncRequests = 0;
  globalThis.__insightsToasts = [];

  const { storage } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        claimAnonymousAnalyticsEvents: async () => {
          globalThis.__insightsClaimCalls += 1;
          if (globalThis.__insightsClaimMode === "rejection") {
            throw new Error("database unavailable");
          }
          return globalThis.__insightsClaimMode === "success"
            ? { success: true, claimed: 1 }
            : { success: false, claimed: 0, code: "AUTH_CONTEXT_CHANGED" };
        },
        countUnclaimedAnalyticsEvents: async () => globalThis.__insightsUnclaimedCount,
        countAnalyticsEventsAwaitingUpload: async () => globalThis.__insightsAwaitingUploadCount,
        onAnalyticsChanged: () => () => {},
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-insights-sync-opt-in-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/components/ui/dialog": "export const ConfirmDialog = () => null;",
      "/components/ui/useToast": `
        const toast = (props) => globalThis.__insightsToasts.push(props);
        export const useToast = () => ({ toast });
      `,
      "/helpers/insightsConsentCoordinator": `
        export const answerInsightsConsent = () => {};
        export const cancelInsightsConsent = () => {};
        export const requestInsightsConsent = async () => {
          globalThis.__insightsConsentRequests += 1;
          return globalThis.__insightsClaimAccepted;
        };
      `,
      "./useAuth": `
        export const useAuth = () => ({
          isLoaded: true,
          isSignedIn: true,
          user: { id: "account-1" }
        });
      `,
      "./useSettings": `
        export const useSettings = () => ({
          insightsSyncEnabled: globalThis.__insightsSyncEnabled,
          setInsightsSyncEnabled: (enabled) => {
            globalThis.__insightsSyncEnabled = enabled;
            globalThis.__insightsSetEnabledValues.push(enabled);
          }
        });
      `,
      "/lib/authRequestContext": `
        export const getAuthRequestContextSnapshot = () => ({
          sessionUserId: globalThis.__insightsSessionUserId
        });
        export const getValidatedAuthGeneration = () => globalThis.__insightsAuthGeneration;
      `,
      "/services/SyncService.js": `
        export const syncService = {
          requestSyncAll: () => { globalThis.__insightsSyncRequests += 1; }
        };
      `,
      "/stores/leaderboardParticipationStore": `
        const state = {
          ready: true,
          enabled: false,
          configured: false,
          error: null,
          updating: false,
          refresh: async () => { globalThis.__insightsParticipationRefreshes += 1; },
          reset: () => { globalThis.__insightsParticipationResets += 1; },
          join: async () => {
            globalThis.__insightsJoinCalls += 1;
            if (globalThis.__insightsJoinMode.startsWith("auth-change")) {
              globalThis.__insightsAuthGeneration += 1;
            }
            return globalThis.__insightsJoinMode === "success" ||
              globalThis.__insightsJoinMode === "auth-change-success";
          },
          leave: async () => true,
          queueLeave: (userId) => { globalThis.__insightsQueuedLeaves.push(userId); }
        };
        export const useLeaderboardParticipationStore = (selector) => selector(state);
        useLeaderboardParticipationStore.getState = () => state;
      `,
      "/stores/policyRules": `
        export const canChangeCloudBackupPreference = () => true;
        export const isCloudBackupAllowed = () => true;
      `,
      "/stores/policyStore": `
        export const usePolicyStore = (selector) => selector({});
      `,
      "react-i18next": `
        const t = (key) => key;
        export const useTranslation = () => ({ t });
      `,
    },
  });
  const { useInsightsSyncOptIn } = await vite.ssrLoadModule("/hooks/useInsightsSyncOptIn.tsx");

  function Harness() {
    hook = useInsightsSyncOptIn();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
  });
  assert.equal(
    globalThis.__insightsParticipationRefreshes,
    1,
    "every combined-preference surface reconciles account participation on mount"
  );

  globalThis.__insightsAuthGeneration = null;
  await React.act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
  });
  assert.equal(globalThis.__insightsParticipationRefreshes, 1);
  assert.equal(
    globalThis.__insightsParticipationResets,
    1,
    "an unvalidated credential must not start an account request"
  );

  globalThis.__insightsAuthGeneration = 7;
  await React.act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
  });
  assert.equal(
    globalThis.__insightsParticipationRefreshes,
    2,
    "auth revalidation must retry participation automatically"
  );

  const enableAndJoin = async () => {
    let result;
    await React.act(async () => {
      result = await hook.joinLeaderboard();
    });
    return result;
  };

  assert.equal(await enableAndJoin(), false);
  assert.deepEqual(globalThis.__insightsToasts, [
    { title: "insights.syncEnableError", variant: "destructive" },
  ]);
  assert.deepEqual(globalThis.__insightsSetEnabledValues, []);
  assert.equal(globalThis.__insightsSyncRequests, 0);

  globalThis.__insightsClaimMode = "rejection";
  assert.equal(await enableAndJoin(), false);
  assert.equal(globalThis.__insightsToasts.length, 2);
  assert.deepEqual(globalThis.__insightsSetEnabledValues, []);

  globalThis.__insightsClaimAccepted = false;
  const claimCallsBeforeDecline = globalThis.__insightsClaimCalls;
  assert.equal(await enableAndJoin(), false);
  assert.equal(globalThis.__insightsClaimCalls, claimCallsBeforeDecline);
  assert.equal(globalThis.__insightsToasts.length, 2, "declining consent must stay quiet");

  globalThis.__insightsClaimAccepted = true;
  globalThis.__insightsClaimMode = "success";
  globalThis.__insightsJoinMode = "failure";
  assert.equal(await enableAndJoin(), false);
  assert.deepEqual(globalThis.__insightsSetEnabledValues, [false]);
  assert.equal(globalThis.__insightsSyncRequests, 0);
  assert.equal(globalThis.__insightsJoinCalls, 1);
  assert.deepEqual(globalThis.__insightsToasts.at(-1), {
    title: "insights.leaderboard.activationError",
    variant: "destructive",
  });

  globalThis.__insightsJoinMode = "success";
  assert.equal(await enableAndJoin(), true);
  assert.deepEqual(globalThis.__insightsSetEnabledValues, [false, true]);
  assert.equal(globalThis.__insightsSyncRequests, 1);
  assert.equal(globalThis.__insightsJoinCalls, 2);
  assert.equal(globalThis.__insightsToasts.length, 3);

  await React.act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
  });
  const settingsWritesBeforeLegacyFailure = globalThis.__insightsSetEnabledValues.length;
  globalThis.__insightsJoinMode = "failure";
  assert.equal(await enableAndJoin(), false);
  assert.equal(
    globalThis.__insightsSetEnabledValues.length,
    settingsWritesBeforeLegacyFailure,
    "a failed leaderboard join must preserve sync that was already enabled"
  );

  const settingsWritesBeforeStaleFailure = globalThis.__insightsSetEnabledValues.length;
  const toastsBeforeStaleFailure = globalThis.__insightsToasts.length;
  globalThis.__insightsAuthGeneration = 7;
  globalThis.__insightsJoinMode = "auth-change-failure";
  assert.equal(await enableAndJoin(), false);
  assert.equal(globalThis.__insightsSetEnabledValues.length, settingsWritesBeforeStaleFailure);
  assert.equal(globalThis.__insightsToasts.length, toastsBeforeStaleFailure);

  globalThis.__insightsAuthGeneration = 7;
  globalThis.__insightsJoinMode = "auth-change-success";
  assert.equal(await enableAndJoin(), false);
  assert.equal(globalThis.__insightsSetEnabledValues.length, settingsWritesBeforeStaleFailure);
  assert.equal(globalThis.__insightsToasts.length, toastsBeforeStaleFailure);
  assert.deepEqual(JSON.parse(storage.getItem("leaderboardLeavePendingUserIds")), ["account-1"]);

  globalThis.__insightsAwaitingUploadCount = 0;
  globalThis.__insightsUnclaimedCount = 0;
  globalThis.__insightsAuthGeneration = 7;
  globalThis.__insightsJoinMode = "success";
  const consentRequestsBeforeEmptyJoin = globalThis.__insightsConsentRequests;
  const claimCallsBeforeEmptyJoin = globalThis.__insightsClaimCalls;
  assert.equal(await enableAndJoin(), true);
  assert.equal(
    globalThis.__insightsConsentRequests,
    consentRequestsBeforeEmptyJoin + 1,
    "sharing the account profile still requires consent when there are no counters to upload"
  );
  assert.equal(
    globalThis.__insightsClaimCalls,
    claimCallsBeforeEmptyJoin,
    "zero pending rows need disclosure, not a pointless claim mutation"
  );

  globalThis.__insightsAuthGeneration = null;
  assert.equal(await hook.disableInsightsSync(), false);
  assert.deepEqual(
    globalThis.__insightsQueuedLeaves,
    ["account-1"],
    "an opt-out taken during auth revalidation must wait for that account instead of being lost"
  );

  globalThis.__insightsAuthGeneration = 8;
  globalThis.__insightsSessionUserId = "account-2";
  assert.equal(await hook.disableInsightsSync(), false);
  assert.deepEqual(
    globalThis.__insightsQueuedLeaves,
    ["account-1", "account-1"],
    "a click on the departing account's stale surface remains scoped to that account"
  );

  await React.act(async () => root.unmount());
  root = null;
});

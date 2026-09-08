const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("accepted Insights claims report failures without enabling sync or joining", async (t) => {
  let root = null;
  let hook;
  t.mock.method(console, "error", () => {});
  t.after(() => {
    for (const key of [
      "__insightsClaimAccepted",
      "__insightsClaimCalls",
      "__insightsClaimMode",
      "__insightsJoinCalls",
      "__insightsSetEnabledCalls",
      "__insightsSyncRequests",
      "__insightsToasts",
    ]) {
      delete globalThis[key];
    }
  });

  globalThis.__insightsClaimAccepted = true;
  globalThis.__insightsClaimCalls = 0;
  globalThis.__insightsClaimMode = "failure";
  globalThis.__insightsJoinCalls = 0;
  globalThis.__insightsSetEnabledCalls = 0;
  globalThis.__insightsSyncRequests = 0;
  globalThis.__insightsToasts = [];

  installBrowserGlobals(t, {
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
        countUnclaimedAnalyticsEvents: async () => 1,
        countAnalyticsEventsAwaitingUpload: async () => 1,
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
        export const requestInsightsConsent = async () => globalThis.__insightsClaimAccepted;
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
          insightsSyncEnabled: false,
          setInsightsSyncEnabled: () => { globalThis.__insightsSetEnabledCalls += 1; }
        });
      `,
      "/lib/authRequestContext": `
        export const getValidatedAuthGeneration = () => 7;
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
          error: null,
          updating: false,
          refresh: async () => {},
          reset: () => {},
          join: async () => { globalThis.__insightsJoinCalls += 1; },
          leave: async () => true
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

  const enable = async () => {
    let result;
    await React.act(async () => {
      result = await hook.enableInsightsSync();
    });
    return result;
  };

  assert.equal(await enable(), false);
  assert.deepEqual(globalThis.__insightsToasts, [
    { title: "insights.syncEnableError", variant: "destructive" },
  ]);
  assert.equal(globalThis.__insightsSetEnabledCalls, 0);
  assert.equal(globalThis.__insightsSyncRequests, 0);

  globalThis.__insightsClaimMode = "rejection";
  assert.equal(await enable(), false);
  assert.equal(globalThis.__insightsToasts.length, 2);
  assert.equal(globalThis.__insightsSetEnabledCalls, 0);

  globalThis.__insightsClaimAccepted = false;
  const claimCallsBeforeDecline = globalThis.__insightsClaimCalls;
  assert.equal(await enable(), false);
  assert.equal(globalThis.__insightsClaimCalls, claimCallsBeforeDecline);
  assert.equal(globalThis.__insightsToasts.length, 2, "declining consent must stay quiet");

  globalThis.__insightsClaimAccepted = true;
  globalThis.__insightsClaimMode = "success";
  assert.equal(await enable(), true);
  assert.equal(globalThis.__insightsSetEnabledCalls, 1);
  assert.equal(globalThis.__insightsSyncRequests, 1);
  assert.equal(globalThis.__insightsToasts.length, 2);

  await React.act(async () => root.unmount());
  root = null;
});

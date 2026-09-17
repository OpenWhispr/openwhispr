const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("Insights Sync opt-in changes only device analytics consent", async (t) => {
  let root = null;
  let hook;
  t.mock.method(console, "error", () => {});
  t.after(() => {
    for (const key of [
      "__insightsAwaitingUploadCount",
      "__insightsClaimAccepted",
      "__insightsClaimCalls",
      "__insightsClaimMode",
      "__insightsConsentRequests",
      "__insightsAuthGeneration",
      "__insightsSetEnabledValues",
      "__insightsSyncEnabled",
      "__insightsSyncRequests",
      "__insightsToasts",
      "__insightsUnclaimedCount",
    ]) {
      delete globalThis[key];
    }
  });

  globalThis.__insightsAwaitingUploadCount = 1;
  globalThis.__insightsClaimAccepted = true;
  globalThis.__insightsClaimCalls = 0;
  globalThis.__insightsClaimMode = "failure";
  globalThis.__insightsConsentRequests = 0;
  globalThis.__insightsAuthGeneration = 7;
  globalThis.__insightsSetEnabledValues = [];
  globalThis.__insightsSyncEnabled = false;
  globalThis.__insightsSyncRequests = 0;
  globalThis.__insightsToasts = [];
  globalThis.__insightsUnclaimedCount = 1;

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        claimAnonymousAnalyticsEvents: async () => {
          globalThis.__insightsClaimCalls += 1;
          if (globalThis.__insightsClaimMode === "rejection") {
            throw new Error("database unavailable");
          }
          if (globalThis.__insightsClaimMode === "auth-change-success") {
            globalThis.__insightsAuthGeneration += 1;
          }
          return globalThis.__insightsClaimMode === "success" ||
            globalThis.__insightsClaimMode === "auth-change-success"
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
        export const useAuth = () => ({ user: { id: "account-1" } });
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
        export const getValidatedAuthGeneration = () => globalThis.__insightsAuthGeneration;
      `,
      "/services/SyncService.js": `
        export const syncService = {
          requestSyncAll: () => { globalThis.__insightsSyncRequests += 1; }
        };
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

  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
  };
  const enable = async () => {
    let result;
    await React.act(async () => {
      result = await hook.enableInsightsSync();
    });
    return result;
  };

  root = createRoot(container);
  await render();

  assert.equal(await enable(), false);
  assert.deepEqual(globalThis.__insightsToasts, [
    { title: "insights.syncEnableError", variant: "destructive" },
  ]);
  assert.deepEqual(globalThis.__insightsSetEnabledValues, []);
  assert.equal(globalThis.__insightsSyncRequests, 0);

  globalThis.__insightsClaimMode = "rejection";
  assert.equal(await enable(), false);
  assert.equal(globalThis.__insightsToasts.length, 2);
  assert.deepEqual(globalThis.__insightsSetEnabledValues, []);

  globalThis.__insightsClaimAccepted = false;
  const claimCallsBeforeDecline = globalThis.__insightsClaimCalls;
  assert.equal(await enable(), false);
  assert.equal(globalThis.__insightsClaimCalls, claimCallsBeforeDecline);
  assert.equal(globalThis.__insightsToasts.length, 2, "declining consent stays quiet");

  globalThis.__insightsClaimAccepted = true;
  globalThis.__insightsClaimMode = "success";
  assert.equal(await enable(), true);
  assert.deepEqual(globalThis.__insightsSetEnabledValues, [true]);
  assert.equal(globalThis.__insightsSyncRequests, 1);

  await React.act(async () => hook.disableInsightsSync());
  assert.deepEqual(globalThis.__insightsSetEnabledValues, [true, false]);
  assert.equal(globalThis.__insightsSyncRequests, 1);

  await render();
  globalThis.__insightsClaimMode = "auth-change-success";
  const settingsWritesBeforeAuthChange = globalThis.__insightsSetEnabledValues.length;
  assert.equal(await enable(), false);
  assert.equal(globalThis.__insightsSetEnabledValues.length, settingsWritesBeforeAuthChange);

  globalThis.__insightsAuthGeneration = 7;
  globalThis.__insightsAwaitingUploadCount = 0;
  globalThis.__insightsUnclaimedCount = 0;
  globalThis.__insightsClaimMode = "success";
  const consentRequestsBeforeEmptyEnable = globalThis.__insightsConsentRequests;
  const claimCallsBeforeEmptyEnable = globalThis.__insightsClaimCalls;
  await render();
  assert.equal(await enable(), true);
  assert.equal(globalThis.__insightsConsentRequests, consentRequestsBeforeEmptyEnable);
  assert.equal(globalThis.__insightsClaimCalls, claimCallsBeforeEmptyEnable);
  assert.equal(globalThis.__insightsSyncRequests, 2);

  await React.act(async () => root.unmount());
  root = null;
});

const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("managed local transcription does not offer a provider switch in the upgrade prompt", async (t) => {
  installBrowserGlobals(t);
  globalThis.__managedLocalTranscription = true;
  t.after(() => delete globalThis.__managedLocalTranscription);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upgrade-prompt-managed-local-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t(key) { return key; } };
        }
      `,
      "/hooks/useUsage": `
        export function useUsage() {
          return { isPastDue: false, checkoutLoading: false, openCheckout() {} };
        }
      `,
      "/hooks/useBillingPortal": `
        export function useBillingPortal() { return { openBillingPortal() {} }; }
      `,
      "/hooks/useManagedLocalModelLock": `
        export function useManagedLocalModelLock() {
          return { managed: globalThis.__managedLocalTranscription, selection: null };
        }
      `,
      "/stores/settingsStore": `
        export const useSettingsStore = { getState() { return {}; } };
      `,
      "/ui/dialog": `
        import React from "react";
        export function Dialog({ open, children }) { return open ? children : null; }
        export function DialogContent({ children }) { return React.createElement("div", null, children); }
      `,
    },
  });
  const { default: UpgradePrompt } = await vite.ssrLoadModule("/components/UpgradePrompt.tsx");
  const render = () =>
    renderToStaticMarkup(
      React.createElement(UpgradePrompt, {
        open: true,
        onOpenChange() {},
      })
    );

  assert.doesNotMatch(render(), /upgradePrompt\.useApiKey/);
  assert.match(render(), /upgradePrompt\.switchToLocal/);

  globalThis.__managedLocalTranscription = false;
  assert.match(render(), /upgradePrompt\.useApiKey/);
});

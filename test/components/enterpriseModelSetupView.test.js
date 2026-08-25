const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("pure setup view keeps approved order and exposes literal row states", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-view-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
      "lucide-react": `
        import React from "react";
        const Icon = () => React.createElement("span");
        export const AlertCircle = Icon; export const Check = Icon;
        export const Download = Icon; export const Loader2 = Icon; export const Lock = Icon;
      `,
      "/ui/ProviderIcon": `export const ProviderIcon = () => null;`,
    },
  });
  const { EnterpriseModelSetupStep } = await vite.ssrLoadModule(
    "/components/onboarding/EnterpriseModelSetupStep.tsx"
  );
  const markup = renderToStaticMarkup(
    React.createElement(EnterpriseModelSetupStep, {
      rows: [
        {
          key: "nvidia:p",
          category: "dictation",
          provider: "nvidia",
          model: "p",
          label: "First",
          status: "blocked",
          disabledReason: "Unsupported device",
        },
        {
          key: "whisper:base",
          category: "dictation",
          provider: "whisper",
          model: "base",
          label: "Second",
          status: "downloading",
          progress: 42,
        },
        {
          key: "qwen:q",
          category: "assistant",
          provider: "qwen",
          model: "q",
          label: "Third",
          status: "installed",
        },
      ],
      busy: true,
      ready: false,
      errorMessage: null,
      onSelect() {},
      onRetry() {},
      onSignOut() {},
    })
  );
  assert.ok(markup.indexOf("First") < markup.indexOf("Second"));
  assert.ok(markup.indexOf("Second") < markup.indexOf("Third"));
  assert.match(markup, /Unsupported device/);
  assert.match(markup, /42%/);
  assert.match(markup, /onboarding\.managedLocal\.status\.installed/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-busy="true"/);
});

test("pure setup recovery is non-dismissible and keeps retry and sign out reachable", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-view-error-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
      "lucide-react": `import React from "react"; export const AlertCircle = () => React.createElement("span"); export const Check = AlertCircle; export const Download = AlertCircle; export const Loader2 = AlertCircle; export const Lock = AlertCircle;`,
      "/ui/ProviderIcon": `export const ProviderIcon = () => null;`,
      "/ui/dialog": `
        import React from "react";
        const cancelable = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
        export const Dialog = ({ open, children }) => open ? React.createElement(React.Fragment, null, children) : null;
        export const DialogContent = ({ children, hideClose, onEscapeKeyDown, onPointerDownOutside, onFocusOutside }) => {
          const escape = cancelable(); const pointer = cancelable(); const focus = cancelable();
          onEscapeKeyDown?.(escape); onPointerDownOutside?.(pointer); onFocusOutside?.(focus);
          return React.createElement("section", {
            "data-hide-close": String(Boolean(hideClose)),
            "data-escape-blocked": String(escape.defaultPrevented),
            "data-pointer-blocked": String(pointer.defaultPrevented),
            "data-focus-blocked": String(focus.defaultPrevented),
          }, children);
        };
        export const DialogHeader = ({ children }) => React.createElement("header", null, children);
        export const DialogTitle = ({ children }) => React.createElement("h2", null, children);
        export const DialogDescription = ({ children }) => React.createElement("p", null, children);
      `,
    },
  });
  const { EnterpriseModelSetupStep } = await vite.ssrLoadModule(
    "/components/onboarding/EnterpriseModelSetupStep.tsx"
  );
  const markup = renderToStaticMarkup(
    React.createElement(EnterpriseModelSetupStep, {
      rows: [],
      busy: false,
      ready: false,
      errorMessage: "No compatible model",
      onSelect() {},
      onRetry() {},
      onSignOut() {},
    })
  );
  assert.match(markup, /No compatible model/);
  assert.match(markup, /common\.retry/);
  assert.match(markup, /settingsPage\.account\.signOut\.signOut/);
  assert.match(markup, /data-hide-close="true"/);
  assert.match(markup, /data-escape-blocked="true"/);
  assert.match(markup, /data-pointer-blocked="true"/);
  assert.match(markup, /data-focus-blocked="true"/);
});

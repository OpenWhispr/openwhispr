const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("cleanup toast keeps the AWS error primary and the pasted-raw status quieter", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__cleanupFailureToasts;
  });
  globalThis.__cleanupFailureToasts = [];
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cleanup-failure-toast-",
    mockModules: {
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__cleanupFailureToasts.push(props)
        });
      `,
      "/utils/windowContext": `
        export const isDictationPanelWindow = () => false;
      `,
    },
  });
  const { default: CleanupFailureToastListener } = await vite.ssrLoadModule(
    "/components/CleanupFailureToastListener.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  const { recordCleanupFailure, useCleanupFailureStore } = await vite.ssrLoadModule(
    "/stores/cleanupFailureStore.ts"
  );
  useCleanupFailureStore.setState({ pending: 0, lastMessage: "", lastFailure: null });

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(CleanupFailureToastListener)));

  const failure = {
    message:
      "AWS Bedrock is temporarily unavailable due to high demand. This is an AWS service issue, not an OpenWhispr outage. Please try again in a few minutes.",
    technicalDetails: {
      status: 503,
      exceptionType: "ServiceUnavailableException",
      requestId: "aws-request-503",
      underlyingError: "Bedrock overloaded",
    },
  };
  await React.act(async () => recordCleanupFailure(failure));

  assert.equal(globalThis.__cleanupFailureToasts.length, 1);
  assert.deepEqual(globalThis.__cleanupFailureToasts[0], {
    title: failure.message,
    secondaryDescription: "Original dictation pasted without AI cleanup.",
    technicalDetails: failure.technicalDetails,
    variant: "destructive",
    duration: 10_000,
  });
});

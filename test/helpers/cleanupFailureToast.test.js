const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("cleanup toast localizes AWS recovery guidance and keeps fallback status quieter", async (t) => {
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
  await i18n.changeLanguage("es");
  const { recordCleanupFailure, useCleanupFailureStore } = await vite.ssrLoadModule(
    "/stores/cleanupFailureStore.ts"
  );
  useCleanupFailureStore.setState({ pending: 0, lastMessage: "", lastFailure: null });

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(CleanupFailureToastListener)));

  const failure = {
    message:
      "AWS Bedrock is temporarily unavailable due to high demand. This is an AWS service issue, not an OpenWhispr outage. Please try again in a few minutes.",
    messageKey: "reasoning.enterprise.errors.bedrock.serviceUnavailable",
    action: "Run the command below in your terminal to re-authenticate:",
    actionKey: "reasoning.enterprise.errors.bedrock.actions.reauthenticate",
    copyCommand: "aws sso login --profile company-sso",
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
    title:
      "AWS Bedrock no está disponible temporalmente debido a una alta demanda. Este es un problema del servicio de AWS, no una interrupción de OpenWhispr. Vuelve a intentarlo en unos minutos.",
    description: "Ejecuta el siguiente comando en tu terminal para volver a autenticarte:",
    secondaryDescription: "Tu dictado se pegó sin limpieza con IA.",
    copyCommand: "aws sso login --profile company-sso",
    technicalDetails: failure.technicalDetails,
    variant: "destructive",
    duration: 10_000,
  });
});

test("technical AWS details use the selected UI language", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-technical-error-details-",
  });
  const { TechnicalErrorDetails } = await vite.ssrLoadModule(
    "/components/ui/TechnicalErrorDetails.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("es");

  const markup = renderToStaticMarkup(
    React.createElement(TechnicalErrorDetails, {
      details: {
        status: 503,
        exceptionType: "ServiceUnavailableException",
        requestId: "request-123",
        underlyingError: "Bedrock overloaded",
      },
    })
  );

  assert.match(markup, /Detalles técnicos/);
  assert.match(markup, /Estado HTTP: 503/);
  assert.match(markup, /Excepción de AWS: ServiceUnavailableException/);
  assert.match(markup, /ID de solicitud de AWS: request-123/);
  assert.match(markup, /Error subyacente: Bedrock overloaded/);
  assert.match(markup, /aria-label="Copiar detalles técnicos"/);
});

const CLASSIFIED_FAILURE = {
  message: "OpenAI rejected your API key.",
  surface: "llm",
  messageKey: "providerErrors.authFailed",
  messageParams: { provider: "OpenAI" },
  settingsTarget: "llms",
  technicalDetails: { provider: "OpenAI", status: 401 },
};

async function recordCleanupFailureToast(t, { dictationWindow, failure = CLASSIFIED_FAILURE }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__cleanupFailureToasts;
  });
  globalThis.__cleanupFailureToasts = [];
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cleanup-failure-toast-llm-",
    mockModules: {
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => globalThis.__cleanupFailureToasts.push(props)
        });
      `,
      "/utils/windowContext": `
        export const isDictationPanelWindow = () => ${dictationWindow};
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

  await React.act(async () => recordCleanupFailure(failure));
  return globalThis.__cleanupFailureToasts.at(-1);
}

test("a classified cleanup failure says why, then that the dictation went in raw, with Open Settings and Copy details", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, { dictationWindow: false });
  assert.equal(toastProps.title, "Cleanup failed");
  assert.equal(
    toastProps.description,
    "OpenAI rejected your API key.\nOriginal dictation pasted without AI cleanup."
  );
  assert.deepEqual(
    toastProps.actions.map(({ label, iconOnly }) => ({ label, iconOnly })),
    [
      { label: "Open Settings", iconOnly: undefined },
      { label: "Copy details", iconOnly: true },
    ]
  );
  assert.equal(toastProps.technicalDetails, undefined, "details are behind Copy details");
  assert.equal(toastProps.secondaryDescription, undefined);
  assert.equal(toastProps.presentation, undefined);
});

test("in the dictation window a classified cleanup failure uses the pill's error card", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, { dictationWindow: true });
  assert.equal(toastProps.presentation, "dictation-error");
  assert.equal(toastProps.duration, 10_000);
  assert.equal(toastProps.actions.length, 2);
});

test("a classified failure whose paste was held back leaves the pill alone and claims no paste", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, {
    dictationWindow: true,
    failure: { ...CLASSIFIED_FAILURE, pasted: false },
  });
  assert.equal(toastProps.title, "Cleanup failed");
  assert.equal(toastProps.description, "OpenAI rejected your API key.");
  assert.equal(toastProps.presentation, undefined, "the held-back paste keeps its pill");
});

// The shape cleanupUnconfiguredNotice returns (pinned in dictationRouting.test.js).
const UNCONFIGURED_NOTICE = {
  message: "AI cleanup is on, but no cleanup model is set up.",
  messageKey: "hooks.audioRecording.cleanupUnconfigured",
  surface: "llm",
  settingsTarget: "llms",
  setupKey: "unconfigured\0providers\0",
};

test("an unconfigured-cleanup notice takes the pill's error card with Open Settings", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, {
    dictationWindow: true,
    failure: { ...UNCONFIGURED_NOTICE, pasted: true },
  });
  assert.equal(toastProps.title, "Cleanup failed");
  assert.equal(
    toastProps.description,
    "AI cleanup is on, but no cleanup model is set up.\nOriginal dictation pasted without AI cleanup."
  );
  assert.deepEqual(
    toastProps.actions.map(({ label }) => label),
    ["Open Settings"]
  );
  assert.equal(toastProps.presentation, "dictation-error");
});

test("an unconfigured-cleanup notice for a dictation that was not pasted claims no paste", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, {
    dictationWindow: true,
    failure: { ...UNCONFIGURED_NOTICE, pasted: false },
  });
  assert.equal(toastProps.description, "AI cleanup is on, but no cleanup model is set up.");
  assert.deepEqual(
    toastProps.actions.map(({ label }) => label),
    ["Open Settings"]
  );
  assert.equal(toastProps.presentation, undefined, "the held-back paste keeps its pill");
});

test("a signed-out Cloud cleanup notice says the fix is signing in", async (t) => {
  const toastProps = await recordCleanupFailureToast(t, {
    dictationWindow: false,
    failure: {
      message: "AI cleanup uses OpenWhispr Cloud, but you're signed out.",
      messageKey: "hooks.audioRecording.cleanupSignedOut",
      surface: "llm",
      settingsTarget: "llms",
      setupKey: "signedOut\0openwhispr\0",
      pasted: true,
    },
  });
  assert.equal(toastProps.title, "Cleanup failed");
  assert.equal(
    toastProps.description,
    "AI cleanup uses OpenWhispr Cloud, but you're signed out.\nOriginal dictation pasted without AI cleanup."
  );
  assert.deepEqual(
    toastProps.actions.map(({ label }) => label),
    ["Open Settings"]
  );
});

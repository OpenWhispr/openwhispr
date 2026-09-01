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

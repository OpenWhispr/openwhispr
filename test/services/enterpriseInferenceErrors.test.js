const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("enterprise cleanup preserves AWS technical details on the renderer error", async (t) => {
  const technicalDetails = {
    status: 503,
    exceptionType: "ServiceUnavailableException",
    requestId: "aws-request-1",
    underlyingError: "Service unavailable",
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        processEnterpriseReasoning: async () => ({
          success: false,
          error: "AWS Bedrock is temporarily unavailable.",
          messageKey: "reasoning.enterprise.errors.bedrock.serviceUnavailable",
          messageParams: { region: "eu-west-1" },
          action: "Retry after signing in.",
          actionKey: "reasoning.enterprise.errors.bedrock.actions.refreshManagedAccess",
          copyCommand: "aws sso login --profile company-sso",
          retryable: true,
          technicalDetails,
        }),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-inference-errors-",
    mockModules: {
      "/models/ModelRegistry": `
        export const getOpenAiApiConfig = () => ({ supportsTemperature: true });
        export const isEnterpriseProvider = (provider) => provider === "bedrock";
      `,
      "/stores/settingsStore": `
        export const getSettings = () => ({ cleanupProvider: "bedrock" });
      `,
      "/services/ai/enterpriseSettings": `
        export const getEnterpriseCallSettings = () => ({});
      `,
      "/utils/logger": `
        export default { logReasoning() {} };
      `,
    },
  });
  const { enterpriseProvider } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/enterprise.ts"
  );

  await assert.rejects(
    enterpriseProvider.call({
      text: "raw text",
      model: "anthropic.claude-haiku",
      agentName: null,
      config: { provider: "bedrock", systemPrompt: "Clean it" },
      ctx: { getSystemPrompt: () => "unused" },
    }),
    (error) => {
      assert.equal(error.message, "AWS Bedrock is temporarily unavailable.");
      assert.equal(error.messageKey, "reasoning.enterprise.errors.bedrock.serviceUnavailable");
      assert.deepEqual(error.messageParams, { region: "eu-west-1" });
      assert.equal(error.action, "Retry after signing in.");
      assert.equal(
        error.actionKey,
        "reasoning.enterprise.errors.bedrock.actions.refreshManagedAccess"
      );
      assert.equal(error.copyCommand, "aws sso login --profile company-sso");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.technicalDetails, technicalDetails);
      return true;
    }
  );
});

// Main-process AI SDK factory for enterprise providers (Bedrock, Azure,
// Vertex). These SDKs depend on Node-only APIs (fs, process, AWS/Azure/Google
// credential chains) and can't run in a Vite-bundled renderer, which is why
// they live here and not in `src/services/ai/providers.ts`. The renderer's
// counterpart handles cloud + local providers only.
//
// Each enterprise SDK is required lazily inside its create*Model function so
// app startup doesn't eager-load ~100 MB of AWS/Azure/Google SDKs for users
// who never select an enterprise provider.

const { isAllowedAzureEndpoint } = require("./enterpriseManagedConfig.mjs");

async function getEnterpriseAIModel(provider, model, apiKey, enterprise) {
  switch (provider) {
    case "bedrock":
      return createBedrockModel(model, enterprise);
    case "azure":
      return createAzureModel(model, apiKey, enterprise);
    case "vertex":
      return createVertexModel(model, apiKey, enterprise);
    default:
      throw new Error(`Unsupported enterprise provider: ${provider}`);
  }
}

async function createBedrockModel(model, enterprise) {
  const { createAmazonBedrock } = require("@ai-sdk/amazon-bedrock");
  const region = enterprise?.bedrockRegion || "us-east-1";
  const explicitCredentialSource = enterprise?.managedCredentialProvider
    ? "managed credential provider"
    : enterprise?.bedrockProfile
      ? "profile credential provider"
      : enterprise?.bedrockAccessKeyId || enterprise?.bedrockSecretAccessKey
        ? "static credentials"
        : null;
  const credentials = enterprise?.managedCredentialProvider
    ? await enterprise.managedCredentialProvider()
    : enterprise?.bedrockProfile
      ? await require("@aws-sdk/credential-providers").fromNodeProviderChain({
          profile: enterprise.bedrockProfile,
        })()
      : explicitCredentialSource
        ? {
            accessKeyId: enterprise.bedrockAccessKeyId,
            secretAccessKey: enterprise.bedrockSecretAccessKey,
            sessionToken: enterprise.bedrockSessionToken,
          }
        : null;

  if (
    explicitCredentialSource &&
    (!credentials ||
      typeof credentials.accessKeyId !== "string" ||
      credentials.accessKeyId.length === 0 ||
      typeof credentials.secretAccessKey !== "string" ||
      credentials.secretAccessKey.length === 0)
  ) {
    const error = new Error(
      `AWS ${explicitCredentialSource} returned invalid credentials. Expected accessKeyId and secretAccessKey.`
    );
    error.name = "CredentialsProviderError";
    throw error;
  }

  return createAmazonBedrock({
    region,
    ...(credentials
      ? {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
        }
      : {}),
  })(model);
}

function createAzureModel(model, apiKey, enterprise) {
  const { createAzure } = require("@ai-sdk/azure");
  const managed = Boolean(enterprise?.managedTokenProvider);
  return createAzure({
    ...(managed ? { tokenProvider: enterprise.managedTokenProvider } : { apiKey }),
    baseURL: managed ? toAzureOpenAIBaseUrl(enterprise?.azureEndpoint) : enterprise?.azureEndpoint,
    apiVersion: enterprise?.azureApiVersion || (managed ? "v1" : "2024-10-21"),
  })(model);
}

// One allowlist for managed Azure hosts (resource, AI Services, and Foundry),
// shared with the envelope validator so the two can never disagree.
function toAzureOpenAIBaseUrl(endpoint) {
  if (!isAllowedAzureEndpoint(endpoint)) {
    throw new Error("Managed Azure OpenAI requires a public Azure resource origin");
  }
  return `${new URL(endpoint).origin}/openai`;
}

function createVertexModel(model, apiKey, enterprise) {
  const { createVertex } = require("@ai-sdk/google-vertex");
  if (apiKey) {
    return createVertex({ apiKey })(model);
  }
  return createVertex({
    project: enterprise?.vertexProject,
    location: enterprise?.vertexLocation || "us-central1",
  })(model);
}

module.exports = { getEnterpriseAIModel, toAzureOpenAIBaseUrl };

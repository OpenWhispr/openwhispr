// Main-process AI SDK factory for enterprise providers (Bedrock, Azure,
// Vertex). These SDKs depend on Node-only APIs (fs, process, AWS/Azure/Google
// credential chains) and can't run in a Vite-bundled renderer, which is why
// they live here and not in `src/services/ai/providers.ts`. The renderer's
// counterpart handles cloud + local providers only.
//
// Each enterprise SDK is required lazily inside its create*Model function so
// app startup doesn't eager-load ~100 MB of AWS/Azure/Google SDKs for users
// who never select an enterprise provider.

function getEnterpriseAIModel(provider, model, apiKey, enterprise) {
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

function createBedrockModel(model, enterprise) {
  const { createAmazonBedrock } = require("@ai-sdk/amazon-bedrock");
  const region = enterprise?.bedrockRegion || "us-east-1";

  if (enterprise?.bedrockProfile) {
    const { fromNodeProviderChain } = require("@aws-sdk/credential-providers");
    return createAmazonBedrock({
      region,
      credentialProvider: fromNodeProviderChain({ profile: enterprise.bedrockProfile }),
    })(model);
  }

  if (enterprise?.bedrockAccessKeyId && enterprise?.bedrockSecretAccessKey) {
    return createAmazonBedrock({
      region,
      accessKeyId: enterprise.bedrockAccessKeyId,
      secretAccessKey: enterprise.bedrockSecretAccessKey,
      sessionToken: enterprise.bedrockSessionToken,
    })(model);
  }

  return createAmazonBedrock({ region })(model);
}

function createAzureModel(model, apiKey, enterprise) {
  const { createAzure } = require("@ai-sdk/azure");
  return createAzure({
    apiKey,
    baseURL: enterprise?.azureEndpoint,
    apiVersion: enterprise?.azureApiVersion || "2024-10-21",
  })(model);
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

module.exports = { getEnterpriseAIModel };

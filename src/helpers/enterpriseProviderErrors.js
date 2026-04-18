/**
 * Maps enterprise provider errors to user-actionable messages.
 * Each mapped error includes a human-readable message and optionally
 * an action hint and a shell command the user can copy-paste.
 */

function mapBedrockError(error, config = {}) {
  const msg = error?.message || error?.code || String(error);
  const profile = config.bedrockProfile || "default";
  const region = config.bedrockRegion || "us-east-1";

  if (msg.includes("ExpiredToken") || msg.includes("expired")) {
    return {
      message: "AWS SSO session expired.",
      action: "Run the command below in your terminal to re-authenticate:",
      copyCommand: `aws sso login --profile ${profile}`,
      retryable: true,
    };
  }
  if (msg.includes("AccessDenied")) {
    return {
      message: `Model access not enabled. Enable it in the AWS Bedrock console for region ${region}.`,
      action: "Open the AWS Bedrock console and request model access.",
    };
  }
  if (msg.includes("ValidationException") || msg.includes("not found")) {
    return {
      message: `Model not found in region ${region}. Check the model ID format.`,
      action: "Bedrock model IDs look like: anthropic.claude-sonnet-4-20250514-v1:0",
    };
  }
  if (msg.includes("UnrecognizedClient") || msg.includes("InvalidSignature")) {
    return {
      message: "Invalid AWS credentials. Check your access key ID and secret.",
    };
  }
  if (msg.includes("Throttling") || msg.includes("TooManyRequests")) {
    return {
      message: "Rate limited by AWS Bedrock. Wait a moment and retry.",
      retryable: true,
    };
  }
  return { message: `AWS Bedrock error: ${msg}` };
}

function mapAzureError(error) {
  const status = error?.status || error?.statusCode;
  const msg = error?.message || error?.code || String(error);

  if (status === 401 || msg.includes("Unauthorized") || msg.includes("invalid")) {
    return { message: "Invalid API key for Azure OpenAI resource." };
  }
  if (status === 404 || msg.includes("DeploymentNotFound") || msg.includes("not found")) {
    return {
      message: "Deployment not found. Verify the deployment name in Azure portal.",
      action: "Check Azure OpenAI Studio → Deployments for the correct name.",
    };
  }
  if (status === 429 || msg.includes("TooManyRequests") || msg.includes("rate")) {
    return {
      message: "Azure OpenAI rate limit reached. Wait or increase quota.",
      retryable: true,
    };
  }
  if (msg.includes("ENOTFOUND") || msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
    return {
      message: "Cannot reach Azure endpoint. Check the endpoint URL.",
      action: "Ensure the URL looks like: https://yourresource.openai.azure.com",
    };
  }
  if (msg.includes("content_filter") || msg.includes("ContentFilter")) {
    return {
      message: "Content was filtered by Azure content safety. Adjust safety settings if needed.",
    };
  }
  return { message: `Azure OpenAI error: ${msg}` };
}

function mapVertexError(error, config = {}) {
  const msg = error?.message || error?.code || String(error);
  const project = config.vertexProject || "";

  if (msg.includes("UNAUTHENTICATED") || msg.includes("Could not load the default credentials")) {
    return {
      message: "GCP credentials not found.",
      action: "Run the command below in your terminal:",
      copyCommand: "gcloud auth application-default login",
      retryable: true,
    };
  }
  if (msg.includes("PERMISSION_DENIED") || msg.includes("403")) {
    return {
      message: "Vertex AI API not enabled or insufficient permissions.",
      action: "Enable the API in GCP Console.",
      copyCommand: `gcloud services enable aiplatform.googleapis.com --project=${project}`,
    };
  }
  if (msg.includes("NOT_FOUND") || msg.includes("404")) {
    return {
      message: `Model not found in project ${project}.`,
      action: "Check the model ID and ensure it's available in your region.",
    };
  }
  if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
    return {
      message: "Vertex AI quota exceeded. Check your quota in GCP Console.",
      retryable: true,
    };
  }
  if (msg.includes("INVALID_ARGUMENT")) {
    return { message: "Invalid Vertex AI API key or argument." };
  }
  return { message: `Vertex AI error: ${msg}` };
}

/**
 * Maps a provider-specific error to an actionable user message.
 * @param {"bedrock"|"azure"|"vertex"} provider
 * @param {Error} error
 * @param {Record<string,string>} config - provider config for contextual messages
 * @returns {{ message: string, action?: string, copyCommand?: string, retryable?: boolean }}
 */
function mapEnterpriseError(provider, error, config = {}) {
  switch (provider) {
    case "bedrock":
      return mapBedrockError(error, config);
    case "azure":
      return mapAzureError(error);
    case "vertex":
      return mapVertexError(error, config);
    default:
      return { message: error?.message || String(error) };
  }
}

const ENTERPRISE_PROVIDERS = ["bedrock", "azure", "vertex"];

function isEnterpriseProvider(value) {
  return typeof value === "string" && ENTERPRISE_PROVIDERS.includes(value);
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
]);

const BLOCKED_SUFFIXES = [".internal", ".localhost", ".local"];

function isPrivateIPv4(hostname) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [, a, b] = match.map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(hostname) {
  if (hostname === "::1") return true;
  if (/^(fe80|fc[0-9a-f]{2}|fd[0-9a-f]{2}):/i.test(hostname)) return true;
  const mapped = hostname.match(/^::ffff:(.+)$/i);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

/**
 * SSRF guard for enterprise HTTP endpoints (currently only Azure).
 * Throws if the URL is non-HTTPS or resolves to a private/metadata host.
 * Note: DNS rebinding is not mitigated — hostnames resolve per-request.
 */
function validateEnterpriseEndpoint(endpoint) {
  if (!endpoint) return;
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("Endpoint must use HTTPS.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTS.has(hostname) ||
    BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    isPrivateIPv4(hostname) ||
    isPrivateIPv6(hostname)
  ) {
    throw new Error("Private/metadata endpoints are not allowed.");
  }
}

/**
 * Extracts the enterprise credential/config subset from an IPC payload
 * so SDK factories receive only the fields they expect.
 */
function pickEnterpriseConfig(config = {}) {
  return {
    bedrockRegion: config.bedrockRegion,
    bedrockProfile: config.bedrockProfile,
    bedrockAccessKeyId: config.bedrockAccessKeyId,
    bedrockSecretAccessKey: config.bedrockSecretAccessKey,
    bedrockSessionToken: config.bedrockSessionToken,
    azureEndpoint: config.azureEndpoint,
    azureApiVersion: config.azureApiVersion,
    vertexProject: config.vertexProject,
    vertexLocation: config.vertexLocation,
  };
}

module.exports = {
  ENTERPRISE_PROVIDERS,
  isEnterpriseProvider,
  mapEnterpriseError,
  pickEnterpriseConfig,
  validateEnterpriseEndpoint,
};

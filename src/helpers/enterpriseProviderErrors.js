/**
 * Maps enterprise provider errors to user-actionable messages.
 * Each mapped error includes a human-readable message and optionally
 * an action hint and a shell command the user can copy-paste.
 */

const { classifyNetworkError } = require("./networkErrors");

const BEDROCK_MAX_ATTEMPTS = 6;
const BEDROCK_INITIAL_DELAY_MS = 500;
const BEDROCK_MAX_DELAY_MS = 8_000;

const BEDROCK_SAFE_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function unwrapRetryError(error) {
  let current = error;
  const seen = new Set();
  while (current?.lastError && !seen.has(current)) {
    seen.add(current);
    current = current.lastError;
  }
  return current;
}

function bedrockErrorChain(error) {
  const chain = [];
  let current = unwrapRetryError(error);
  const seen = new Set();
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function getBedrockHttpStatus(error) {
  for (const item of bedrockErrorChain(error)) {
    const status =
      item?.status ?? item?.statusCode ?? item?.$metadata?.httpStatusCode ?? item?.response?.status;
    if (Number.isInteger(status)) return status;
  }
  return undefined;
}

function getHeaderCaseInsensitive(headers, headerName) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(headerName) || undefined;
  const normalizedName = headerName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === normalizedName) return value;
  }
  return undefined;
}

function normalizeBedrockExceptionType(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const namespaceSeparator = trimmed.lastIndexOf("#");
  const withoutNamespace =
    namespaceSeparator === -1 ? trimmed : trimmed.slice(namespaceSeparator + 1);
  const suffixSeparator = withoutNamespace.indexOf(":");
  const normalized =
    suffixSeparator === -1 ? withoutNamespace : withoutNamespace.slice(0, suffixSeparator);
  return normalized.trim() || undefined;
}

function getBedrockExceptionType(error) {
  for (const item of bedrockErrorChain(error)) {
    const headers = item?.responseHeaders || item?.response?.headers;
    const candidates = [
      getHeaderCaseInsensitive(headers, "x-amzn-errortype"),
      item?.data?.code,
      item?.data?.__type,
      item?.data?.type,
      item?.type,
      item?.code,
      item?.name,
    ];
    for (const candidate of candidates) {
      const type = normalizeBedrockExceptionType(candidate);
      if (type && !["Error", "AI_APICallError", "AI_RetryError"].includes(type)) return type;
    }
  }
  return undefined;
}

function getBedrockRequestId(error) {
  for (const item of bedrockErrorChain(error)) {
    const headers = item?.responseHeaders || item?.response?.headers || {};
    const requestId =
      item?.$metadata?.requestId ||
      item?.requestId ||
      getHeaderCaseInsensitive(headers, "x-amzn-requestid") ||
      getHeaderCaseInsensitive(headers, "x-amz-request-id");
    if (requestId) return requestId;
  }
  return undefined;
}

function getBedrockErrorCode(error) {
  for (const item of bedrockErrorChain(error)) {
    if (typeof item?.code === "string") return item.code;
    if (typeof item?.cause?.code === "string") return item.cause.code;
  }
  return undefined;
}

function isBedrockTimeout(error) {
  const status = getBedrockHttpStatus(error);
  const type = (getBedrockExceptionType(error) || "").toLowerCase();
  const code = (getBedrockErrorCode(error) || "").toUpperCase();
  return (
    status === 408 ||
    type === "timeouterror" ||
    type.includes("requesttimeout") ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  );
}

function isSafeBedrockNetworkError(error) {
  if (getBedrockHttpStatus(error) !== undefined) return false;
  const code = (getBedrockErrorCode(error) || "").toUpperCase();
  if (BEDROCK_SAFE_NETWORK_CODES.has(code)) return true;
  return bedrockErrorChain(error).some(
    (item) => item?.name === "TypeError" && /fetch failed|network/i.test(item?.message || "")
  );
}

function getBedrockFailureKind(error) {
  const status = getBedrockHttpStatus(error);
  const type = (getBedrockExceptionType(error) || "").toLowerCase();
  const message = bedrockErrorChain(error)
    .map((item) => item?.message || "")
    .join(" ")
    .toLowerCase();

  if (status === 503 || type.includes("serviceunavailable")) return "unavailable";
  if (
    status === 429 ||
    type.includes("throttl") ||
    type.includes("toomanyrequests") ||
    message.includes("too many requests")
  ) {
    return "throttled";
  }
  if (isBedrockTimeout(error)) return "timeout";
  if (isSafeBedrockNetworkError(error)) return "network";
  return "other";
}

function shouldRetryBedrockError(error) {
  return ["unavailable", "throttled", "timeout", "network"].includes(getBedrockFailureKind(error));
}

function sleepWithAbort(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const onTimeout = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    timer = setTimeout(onTimeout, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runAbortableOperation(operation, signal) {
  if (!signal) return operation();
  signal.throwIfAborted();

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    signal.throwIfAborted();
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function runBedrockRequest(operation, options = {}) {
  const {
    signal,
    maxAttempts = BEDROCK_MAX_ATTEMPTS,
    initialDelayMs = BEDROCK_INITIAL_DELAY_MS,
    maxDelayMs = BEDROCK_MAX_DELAY_MS,
    random = Math.random,
    sleep = sleepWithAbort,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      const underlying = unwrapRetryError(error);
      if (attempt === maxAttempts || !shouldRetryBedrockError(underlying)) throw underlying;
      const backoffCeiling = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempt - 1));
      await sleep(Math.floor(random() * backoffCeiling), signal);
    }
  }

  throw new Error("Bedrock retry loop exited unexpectedly");
}

function getBedrockTechnicalDetails(error) {
  const underlying = unwrapRetryError(error);
  return {
    ...(getBedrockHttpStatus(underlying) !== undefined
      ? { status: getBedrockHttpStatus(underlying) }
      : {}),
    ...(getBedrockExceptionType(underlying)
      ? { exceptionType: getBedrockExceptionType(underlying) }
      : {}),
    ...(getBedrockRequestId(underlying) ? { requestId: getBedrockRequestId(underlying) } : {}),
    underlyingError: underlying?.message || String(underlying),
  };
}

function mapManagedIdentityError(error, provider) {
  const code = error?.code;
  if (!code) return null;
  if (["AUTH_CONTEXT_CHANGED", "AUTH_CONTEXT_UNVALIDATED", "AUTH_EXPIRED"].includes(code)) {
    return {
      message: "Your OpenWhispr session changed or expired.",
      action: "Sign in again, then retry.",
      retryable: true,
    };
  }
  if (code === "SSO_REQUIRED") {
    return {
      message: "Company SSO is required for managed enterprise AI.",
      action: "Sign out and sign back in with your company SSO account.",
    };
  }
  if (code === "DIRECTORY_ASSIGNMENT_REQUIRED") {
    return {
      message: error.message,
      action: "Ask your IT administrator to restore your directory assignment.",
    };
  }
  if (
    [
      "PROVIDER_NOT_ALLOWED",
      "PROVIDER_NOT_CONFIGURED",
      "WORKSPACE_SUBSCRIPTION_REQUIRED",
      "MANAGED_CONFIG_INVALID",
    ].includes(code)
  ) {
    return { message: error.message, action: "Contact your IT administrator." };
  }
  if (code === "IDENTITY_EXCHANGE_FAILED") {
    return {
      message: `Could not obtain temporary ${provider === "bedrock" ? "AWS" : "Azure"} access.`,
      action: "Ask your IT administrator to verify the configured federated identity trust.",
      retryable: true,
    };
  }
  return null;
}

function mapBedrockError(error, config = {}) {
  const underlying = unwrapRetryError(error);
  const msg = underlying?.message || underlying?.code || String(underlying);
  const status = getBedrockHttpStatus(underlying);
  const exceptionType = getBedrockExceptionType(underlying) || "";
  const signature = `${exceptionType} ${msg}`.toLowerCase();
  const profile = config.bedrockProfile || "default";
  const region = config.bedrockRegion || "us-east-1";
  const technicalDetails = getBedrockTechnicalDetails(underlying);
  const withDetails = (mapped) => ({ ...mapped, technicalDetails });

  if (signature.includes("expiredtoken") || signature.includes("expired")) {
    if (config.managedContext) {
      return withDetails({
        message: "Temporary AWS access expired.",
        messageKey: "reasoning.enterprise.errors.bedrock.temporaryAccessExpired",
        action: "Sign out and sign back in to refresh company access, then retry.",
        actionKey: "reasoning.enterprise.errors.bedrock.actions.refreshManagedAccess",
        retryable: true,
      });
    }
    return withDetails({
      message: "AWS SSO session expired.",
      messageKey: "reasoning.enterprise.errors.bedrock.ssoExpired",
      action: "Run the command below in your terminal to re-authenticate:",
      actionKey: "reasoning.enterprise.errors.bedrock.actions.reauthenticate",
      copyCommand: `aws sso login --profile ${profile}`,
      retryable: true,
    });
  }
  if (
    status === 401 ||
    signature.includes("unrecognizedclient") ||
    signature.includes("invalidclienttoken") ||
    signature.includes("invalidsignature") ||
    signature.includes("incompletesignature") ||
    signature.includes("signaturedoesnotmatch")
  ) {
    return withDetails({
      message: "AWS credentials were rejected. Check the access key ID, secret, and session token.",
      messageKey: "reasoning.enterprise.errors.bedrock.credentialsRejected",
    });
  }
  if (status === 403 || signature.includes("accessdenied") || signature.includes("permission")) {
    return withDetails({
      message: `AWS Bedrock denied this request. Ask your AWS administrator to grant permission to invoke the selected model in region ${region}.`,
      messageKey: "reasoning.enterprise.errors.bedrock.accessDenied",
      messageParams: { region },
    });
  }
  if (signature.includes("resourcenotfound") || signature.includes("modelnotfound")) {
    return withDetails({
      message: `AWS Bedrock could not find the selected model in region ${region}. Check the model ID and whether it is available in that region.`,
      messageKey: "reasoning.enterprise.errors.bedrock.modelNotFound",
      messageParams: { region },
    });
  }
  if (status === 400 || signature.includes("validationexception")) {
    return withDetails({
      message: `AWS Bedrock rejected the model configuration for region ${region}. Check the model ID, inference profile, and region.`,
      messageKey: "reasoning.enterprise.errors.bedrock.configurationRejected",
      messageParams: { region },
    });
  }
  if (
    signature.includes("credentialsprovidererror") ||
    signature.includes("configerror") ||
    signature.includes("region is missing") ||
    signature.includes("could not load credentials")
  ) {
    return withDetails({
      message: "AWS Bedrock is not configured correctly. Check the region and AWS credentials.",
      messageKey: "reasoning.enterprise.errors.bedrock.notConfigured",
    });
  }
  const kind = getBedrockFailureKind(underlying);
  if (kind === "unavailable") {
    return withDetails({
      message:
        "AWS Bedrock is temporarily unavailable due to high demand. This is an AWS service issue, not an OpenWhispr outage. Please try again in a few minutes.",
      messageKey: "reasoning.enterprise.errors.bedrock.serviceUnavailable",
      retryable: true,
    });
  }
  if (kind === "throttled") {
    return withDetails({
      message:
        "AWS Bedrock is temporarily limiting requests because it is receiving too many. Please wait a moment and try again. If this continues, ask your AWS administrator to check your Bedrock usage and quotas.",
      messageKey: "reasoning.enterprise.errors.bedrock.throttled",
      retryable: true,
    });
  }
  if (kind === "timeout") {
    return withDetails({
      message:
        "AWS Bedrock did not respond in time. Please try again. If this continues, check your internet connection and AWS Bedrock service status.",
      messageKey: "reasoning.enterprise.errors.bedrock.timeout",
      retryable: true,
    });
  }
  if (kind === "network") {
    return withDetails({
      message: "AWS Bedrock could not be reached. Check your internet connection and try again.",
      messageKey: "reasoning.enterprise.errors.bedrock.network",
      retryable: true,
    });
  }
  return withDetails({
    message: `AWS Bedrock error: ${msg}`,
    messageKey: "reasoning.enterprise.errors.bedrock.unknown",
    messageParams: { error: msg },
  });
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
  if (classifyNetworkError(error).isNetworkError || msg.includes("fetch failed")) {
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
  const managed = mapManagedIdentityError(error, provider);
  if (managed) return managed;
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
  // The URL parser rewrites an IPv4-mapped address to its hex form, so
  // "::ffff:169.254.169.254" reaches us as "::ffff:a9fe:a9fe".
  const mappedHex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
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
  // URL.hostname keeps the brackets around an IPv6 literal ("[::1]"), which no
  // isPrivateIPv6 branch can match — strip them or the whole IPv6 arm is dead.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
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
  runAbortableOperation,
  runBedrockRequest,
  unwrapRetryError,
  validateEnterpriseEndpoint,
};

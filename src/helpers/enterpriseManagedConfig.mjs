const ENTERPRISE_INFERENCE_SCOPES = [
  "dictationCleanup",
  "dictationAgent",
  "noteFormatting",
  "chatIntelligence",
  "dictationTranslation",
];

const ENTERPRISE_PROVIDERS = ["bedrock", "azure"];
const PROVIDER_MODES = ["disabled", "managed_default", "managed_required"];
const AWS_ROLE_ARN = /^arn:(aws|aws-us-gov):iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AZURE_LEGACY_API_VERSION = /^\d{4}-\d{2}-\d{2}(?:-preview)?$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringMap(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isNonEmptyString)
  );
}

function isSafeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
    );
  } catch {
    return false;
  }
}

function isAllowedAzureEndpoint(value) {
  if (!isSafeHttpsUrl(value)) return false;
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  return (
    hostname.endsWith(".openai.azure.com") &&
    hostname.length > ".openai.azure.com".length &&
    (url.pathname === "" || url.pathname === "/") &&
    !url.search &&
    !url.hash
  );
}

function isAllowedAzureApiVersion(value) {
  return value === "v1" || value === "preview" || AZURE_LEGACY_API_VERSION.test(value);
}

function isValidProviderConfig(record) {
  if (!record || !ENTERPRISE_PROVIDERS.includes(record.provider)) return false;
  if (!PROVIDER_MODES.includes(record.mode) || typeof record.allowManualSetup !== "boolean") {
    return false;
  }
  if (!Number.isSafeInteger(record.version) || record.version < 1) return false;
  const config = record.config;
  if (!config || typeof config !== "object") return false;
  const allowed = record.provider === "bedrock" ? config.allowedModels : config.allowedDeployments;
  const defaults = config.scopeDefaults;
  if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every(isNonEmptyString)) {
    return false;
  }
  if (!isStringMap(defaults)) return false;
  if (
    !ENTERPRISE_INFERENCE_SCOPES.every((scope) => isNonEmptyString(defaults[scope])) ||
    !Object.keys(defaults).every((scope) => ENTERPRISE_INFERENCE_SCOPES.includes(scope))
  ) {
    return false;
  }
  if (!Object.values(defaults).every((model) => allowed.includes(model))) return false;

  if (record.provider === "bedrock") {
    const partition = typeof config.roleArn === "string" ? config.roleArn.split(":")[1] : null;
    const isGovRegion = typeof config.region === "string" && config.region.startsWith("us-gov-");
    return (
      AWS_ROLE_ARN.test(config.roleArn) &&
      AWS_REGION.test(config.region) &&
      (partition === "aws-us-gov") === isGovRegion &&
      !config.region.startsWith("cn-")
    );
  }
  return (
    UUID.test(config.tenantId) &&
    UUID.test(config.clientId) &&
    isAllowedAzureEndpoint(config.endpoint) &&
    isAllowedAzureApiVersion(config.apiVersion)
  );
}

function validateManagedEnterpriseEnvelope(value, expectedWorkspaceId) {
  if (!value || typeof value !== "object" || value.workspaceId !== expectedWorkspaceId) return null;
  if (!Number.isSafeInteger(value.version) || value.version < 0) return null;
  const generation = value.generation ?? value.version;
  if (!Number.isSafeInteger(generation) || generation < 0) return null;
  if (!value.identity || typeof value.identity !== "object" || !Array.isArray(value.providers)) {
    return null;
  }
  if (
    !isSafeHttpsUrl(value.identity.issuer) ||
    !isSafeHttpsUrl(value.identity.jwksUri) ||
    value.identity.subject !== `workspace:${expectedWorkspaceId}` ||
    value.identity.audiences?.bedrock !== "sts.amazonaws.com" ||
    value.identity.audiences?.azure !== "api://AzureADTokenExchange"
  ) {
    return null;
  }
  if (!value.providers.every(isValidProviderConfig)) return null;
  if (
    value.refreshAfter !== undefined &&
    (typeof value.refreshAfter !== "string" || Number.isNaN(Date.parse(value.refreshAfter)))
  ) {
    return null;
  }
  if (
    value.azureEndpointContract !== undefined &&
    value.azureEndpointContract !== "resource-origin"
  ) {
    return null;
  }
  return { ...value, generation };
}

function resolutionError(code, message) {
  return { kind: "error", code, message };
}

function resolveManagedEnterpriseScope(envelope, scope, setupMode = "auto") {
  if (!ENTERPRISE_INFERENCE_SCOPES.includes(scope)) {
    return resolutionError("MANAGED_SCOPE_INVALID", "The requested inference scope is invalid.");
  }
  if (!envelope?.providers?.length) return { kind: "manual" };

  const configured = envelope.providers.filter(
    (record) => record.mode !== "disabled" && isNonEmptyString(record.config.scopeDefaults[scope])
  );
  if (!configured.length) return { kind: "manual" };

  const enforced = configured.filter(
    (record) => record.mode === "managed_required" || !record.allowManualSetup
  );
  const candidates = enforced.length ? enforced : setupMode === "manual" ? [] : configured;
  if (!candidates.length) return { kind: "manual" };

  if (candidates.length !== 1) {
    return resolutionError(
      "MANAGED_CONFIG_AMBIGUOUS",
      "Managed enterprise configuration is inconsistent. Contact your IT administrator."
    );
  }
  const [record] = candidates;
  return {
    kind: "managed",
    provider: record.provider,
    model: record.config.scopeDefaults[scope],
    mode: record.mode,
    allowManualSetup: record.allowManualSetup,
    record,
  };
}

export {
  ENTERPRISE_INFERENCE_SCOPES,
  ENTERPRISE_PROVIDERS,
  validateManagedEnterpriseEnvelope,
  resolveManagedEnterpriseScope,
};

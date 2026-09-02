const ENTERPRISE_INFERENCE_SCOPES = [
  "dictationCleanup",
  "dictationAgent",
  "noteFormatting",
  "chatIntelligence",
  "dictationTranslation",
];

/** The managed speech-to-text scope; resolved from the Azure `transcription` config section. */
const ENTERPRISE_TRANSCRIPTION_SCOPE = "transcription";

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

// Azure OpenAI resource hosts, including AI Foundry deployments.
const AZURE_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".cognitiveservices.azure.com",
  ".services.ai.azure.com",
];

function isAllowedAzureEndpoint(value) {
  if (!isSafeHttpsUrl(value)) return false;
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  return (
    AZURE_HOST_SUFFIXES.some(
      (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length
    ) &&
    (url.pathname === "" || url.pathname === "/") &&
    !url.search &&
    !url.hash
  );
}

function isAllowedAzureApiVersion(value) {
  return value === "v1" || value === "preview" || AZURE_LEGACY_API_VERSION.test(value);
}

function isValidLlmSection(allowed, defaults) {
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
  return Object.values(defaults).every((model) => allowed.includes(model));
}

function isValidTranscriptionSection(transcription) {
  return (
    transcription &&
    typeof transcription === "object" &&
    Array.isArray(transcription.allowedDeployments) &&
    transcription.allowedDeployments.length > 0 &&
    transcription.allowedDeployments.every(isNonEmptyString) &&
    isNonEmptyString(transcription.defaultDeployment) &&
    transcription.allowedDeployments.includes(transcription.defaultDeployment)
  );
}

function isValidProviderConfig(record) {
  if (!record || !ENTERPRISE_PROVIDERS.includes(record.provider)) return false;
  if (!PROVIDER_MODES.includes(record.mode) || typeof record.allowManualSetup !== "boolean") {
    return false;
  }
  if (!Number.isSafeInteger(record.version) || record.version < 1) return false;
  const config = record.config;
  if (!config || typeof config !== "object") return false;

  if (record.provider === "bedrock") {
    const partition = typeof config.roleArn === "string" ? config.roleArn.split(":")[1] : null;
    const isGovRegion = typeof config.region === "string" && config.region.startsWith("us-gov-");
    return (
      isValidLlmSection(config.allowedModels, config.scopeDefaults) &&
      AWS_ROLE_ARN.test(config.roleArn) &&
      AWS_REGION.test(config.region) &&
      (partition === "aws-us-gov") === isGovRegion &&
      !config.region.startsWith("cn-")
    );
  }
  // Azure carries independent text and transcription sections; at least one
  // must be present and every present section must be complete.
  const hasLlmSection =
    config.allowedDeployments !== undefined || config.scopeDefaults !== undefined;
  if (!hasLlmSection && config.transcription === undefined) return false;
  if (hasLlmSection && !isValidLlmSection(config.allowedDeployments, config.scopeDefaults)) {
    return false;
  }
  if (config.transcription !== undefined && !isValidTranscriptionSection(config.transcription)) {
    return false;
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

function managedModelFor(record, scope) {
  if (scope === ENTERPRISE_TRANSCRIPTION_SCOPE) {
    return record.config.transcription?.defaultDeployment;
  }
  return record.config.scopeDefaults?.[scope];
}

function resolveManagedEnterpriseScope(envelope, scope, setupMode = "auto") {
  if (!ENTERPRISE_INFERENCE_SCOPES.includes(scope) && scope !== ENTERPRISE_TRANSCRIPTION_SCOPE) {
    return resolutionError("MANAGED_SCOPE_INVALID", "The requested inference scope is invalid.");
  }
  if (!envelope?.providers?.length) return { kind: "manual" };

  const configured = envelope.providers.filter(
    (record) => record.mode !== "disabled" && isNonEmptyString(managedModelFor(record, scope))
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
    model: managedModelFor(record, scope),
    mode: record.mode,
    allowManualSetup: record.allowManualSetup,
    record,
  };
}

export {
  ENTERPRISE_INFERENCE_SCOPES,
  ENTERPRISE_TRANSCRIPTION_SCOPE,
  ENTERPRISE_PROVIDERS,
  validateManagedEnterpriseEnvelope,
  resolveManagedEnterpriseScope,
};

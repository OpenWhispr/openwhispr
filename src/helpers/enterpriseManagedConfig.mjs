const ENTERPRISE_INFERENCE_SCOPES = [
  "dictationCleanup",
  "dictationAgent",
  "noteFormatting",
  "chatIntelligence",
  "dictationTranslation",
];

/** The managed speech-to-text scope; resolved from the Azure `transcription` config section. */
const ENTERPRISE_TRANSCRIPTION_SCOPE = "transcription";

const ENTERPRISE_PROVIDERS = ["bedrock", "azure", "openai-compatible"];
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
  if (config.network !== undefined && !isValidAudioNetwork(config.network)) return false;
  if (record.provider === "openai-compatible") {
    return (
      Boolean(config.batch || config.realtime) &&
      (!config.batch || isValidAudioOperation(config.batch, "https:", true)) &&
      (!config.realtime || isValidAudioOperation(config.realtime, "wss:", true))
    );
  }

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
  if (!hasLlmSection && config.transcription === undefined && config.realtime === undefined)
    return false;
  if (config.realtime !== undefined && !isValidAudioOperation(config.realtime, "wss:", false))
    return false;
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

function managedModelFor(record, scope, operation = "batch") {
  if (scope === ENTERPRISE_TRANSCRIPTION_SCOPE) {
    if (operation === "realtime") return record.config.realtime?.defaultDeployment;
    if (record.provider === "openai-compatible") return record.config.batch?.defaultDeployment;
    return record.config.transcription?.defaultDeployment;
  }
  return record.config.scopeDefaults?.[scope];
}

function resolveManagedEnterpriseScope(envelope, scope, setupMode = "auto", operation = "batch") {
  if (!ENTERPRISE_INFERENCE_SCOPES.includes(scope) && scope !== ENTERPRISE_TRANSCRIPTION_SCOPE) {
    return resolutionError("MANAGED_SCOPE_INVALID", "The requested inference scope is invalid.");
  }
  if (!envelope?.providers?.length) return { kind: "manual" };

  if (scope === ENTERPRISE_TRANSCRIPTION_SCOPE && !["batch", "realtime"].includes(operation))
    return resolutionError("MANAGED_SCOPE_INVALID", "Unsupported audio operation.");
  const audioOwners =
    scope === ENTERPRISE_TRANSCRIPTION_SCOPE
      ? envelope.providers.filter(
          (record) =>
            record.mode !== "disabled" &&
            (record.config.transcription || record.config.batch || record.config.realtime)
        )
      : [];
  if (
    audioOwners.some(
      (record) =>
        (record.mode === "managed_required" || !record.allowManualSetup) &&
        !managedModelFor(record, scope, operation)
    )
  )
    return resolutionError(
      "MANAGED_OPERATION_UNAVAILABLE",
      "Your organization has not configured this enterprise audio operation."
    );
  const configured = envelope.providers.filter(
    (record) =>
      record.mode !== "disabled" && isNonEmptyString(managedModelFor(record, scope, operation))
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
    model: managedModelFor(record, scope, operation),
    mode: record.mode,
    allowManualSetup: record.allowManualSetup,
    record,
  };
}

/**
 * Scopes any active record resolves a managed model for, and the subset that
 * is enforced (managed_required or manual setup disallowed). Enforcement is
 * per scope: a text-only workspace must never fail transcription closed.
 */
function managedScopesForConfig(config) {
  const managed = [];
  const enforced = [];
  for (const record of config?.providers ?? []) {
    if (record.mode === "disabled") continue;
    const isEnforced = record.mode === "managed_required" || !record.allowManualSetup;
    for (const scope of [...ENTERPRISE_INFERENCE_SCOPES, ENTERPRISE_TRANSCRIPTION_SCOPE]) {
      if (
        !isNonEmptyString(managedModelFor(record, scope)) &&
        !(scope === ENTERPRISE_TRANSCRIPTION_SCOPE && record.config.realtime?.defaultDeployment)
      )
        continue;
      if (!managed.includes(scope)) managed.push(scope);
      if (isEnforced && !enforced.includes(scope)) enforced.push(scope);
    }
  }
  return { managed, enforced };
}

function isValidAudioNetwork(network) {
  if (!network || typeof network !== "object") return false;
  for (const [key, min, max] of [
    ["connectTimeoutMs", 1000, 120000],
    ["httpTimeoutMs", 1000, 600000],
    ["idleTimeoutMs", 10000, 600000],
    ["sessionMaxMs", 60000, 3600000],
  ]) {
    if (
      network[key] !== undefined &&
      (!Number.isInteger(network[key]) || network[key] < min || network[key] > max)
    )
      return false;
  }
  if (network.caBundleId && !UUID.test(network.caBundleId)) return false;
  const proxy = network.proxy;
  if (!proxy) return true;
  if (
    !["system", "fixed", "direct"].includes(proxy.mode) ||
    (proxy.mandatory && proxy.mode === "direct")
  )
    return false;
  if (proxy.mode === "fixed") {
    try {
      const url = new URL(proxy.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        return false;
    } catch {
      return false;
    }
  }
  return (
    !proxy.bypass ||
    (Array.isArray(proxy.bypass) &&
      proxy.bypass.length <= 100 &&
      proxy.bypass.every(isNonEmptyString))
  );
}

function isValidAudioOperation(operation, scheme, gateway) {
  if (!isValidTranscriptionSection(operation)) return false;
  if (
    scheme === "wss:" &&
    (!operation ||
      !["openai-transcription-preview", "openai-transcription-ga"].includes(operation.protocol) ||
      operation.sampleRate !== 24000)
  )
    return false;
  if (!gateway)
    return operation.apiVersion === "v1" || AZURE_LEGACY_API_VERSION.test(operation.apiVersion);
  try {
    const url = new URL(operation.endpoint);
    if (
      url.protocol !== scheme ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((key) =>
        /^(api[-_]?key|token|access_token|authorization|secret)$/i.test(key)
      )
    )
      return false;
  } catch {
    return false;
  }
  return (
    ["bearer", "api-key"].includes(operation.authentication?.type) &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(operation.authentication?.credentialSlot)
  );
}

export {
  AZURE_HOST_SUFFIXES,
  ENTERPRISE_INFERENCE_SCOPES,
  ENTERPRISE_TRANSCRIPTION_SCOPE,
  ENTERPRISE_PROVIDERS,
  isAllowedAzureEndpoint,
  validateManagedEnterpriseEnvelope,
  resolveManagedEnterpriseScope,
  managedScopesForConfig,
};

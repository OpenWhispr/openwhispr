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
const LOCAL_TRANSCRIPTION_MODELS = new Set([
  ...["tiny", "base", "small", "medium", "large", "turbo"].map((modelId) => `whisper:${modelId}`),
  ...[
    "parakeet-tdt-0.6b-v3",
    "parakeet-unified-en-0.6b",
    "nemotron-speech-streaming-en-0.6b",
    "nemotron-3.5-asr-streaming-0.6b",
  ].map((modelId) => `nvidia:${modelId}`),
]);
const LOCAL_REASONING_PROVIDERS = new Set([
  "qwen",
  "mistral",
  "llama",
  "openai-oss",
  "gemma",
  "liquidai",
]);
const LOCAL_REASONING_MODELS = new Set([
  ...[
    "qwen3.5-9b-q4_k_m",
    "qwen3.5-4b-q4_k_m",
    "qwen3.5-2b-q4_k_m",
    "qwen3-8b-q4_k_m",
    "qwen3-8b-q5_k_m",
    "qwen3-4b-q4_k_m",
    "qwen3-1.7b-q8_0",
    "qwen3-32b-q4_k_m",
    "qwen2.5-1.5b-instruct-q5_k_m",
    "qwen2.5-3b-instruct-q5_k_m",
    "qwen2.5-7b-instruct-q4_k_m",
    "qwen2.5-7b-instruct-q5_k_m",
  ].map((modelId) => `qwen:${modelId}`),
  ...[
    "mistral-nemo-12b-instruct-q4_k_m",
    "mistral-7b-instruct-v0.3-q4_k_m",
    "mistral-7b-instruct-v0.3-q5_k_m",
  ].map((modelId) => `mistral:${modelId}`),
  ...[
    "llama-3.2-1b-instruct-q4_k_m",
    "llama-3.2-3b-instruct-q4_k_m",
    "llama-3.1-8b-instruct-q4_k_m",
  ].map((modelId) => `llama:${modelId}`),
  "openai-oss:gpt-oss-20b-mxfp4",
  ...[
    "gemma-4-31b-it-q4_k_m",
    "gemma-4-31b-it-qat-q4_0",
    "gemma-4-26b-a4b-it-q4_k_m",
    "gemma-4-26b-a4b-it-qat-q4_0",
    "gemma-4-e4b-it-q4_k_m",
    "gemma-4-e4b-it-qat-q4_0",
    "gemma-4-e2b-it-q4_k_m",
    "gemma-4-e2b-it-qat-q4_0",
    "gemma-3-12b-it-q4_k_m",
    "gemma-3-4b-it-q4_k_m",
    "gemma-3-1b-it-q4_k_m",
  ].map((modelId) => `gemma:${modelId}`),
  ...[
    "lfm2.5-1.2b-instruct-q4_k_m",
    "lfm2.5-8b-a1b-q4_k_m",
    "lfm2-2.6b-q4_k_m",
    "lfm2.5-350m-q8_0",
    "lfm2.5-230m-q8_0",
  ].map((modelId) => `liquidai:${modelId}`),
]);

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

function isValidLocalModelSelection(selection, category) {
  if (
    !selection ||
    typeof selection !== "object" ||
    !isNonEmptyString(selection.provider) ||
    !isNonEmptyString(selection.modelId) ||
    Object.keys(selection).some((key) => !["provider", "modelId"].includes(key))
  ) {
    return false;
  }
  if (category === "transcription") {
    return LOCAL_TRANSCRIPTION_MODELS.has(`${selection.provider}:${selection.modelId}`);
  }
  if (!LOCAL_REASONING_PROVIDERS.has(selection.provider)) return false;
  return LOCAL_REASONING_MODELS.has(`${selection.provider}:${selection.modelId}`);
}

function isValidLocalModelsConfig(localModels) {
  if (localModels === null || localModels === undefined) return true;
  if (!localModels || typeof localModels !== "object") return false;
  if (
    Object.keys(localModels).some(
      (key) =>
        !["transcription", "reasoning", "version", "updatedAt", "updatedByUserId"].includes(key)
    )
  ) {
    return false;
  }
  if (!Array.isArray(localModels.transcription) || !Array.isArray(localModels.reasoning)) {
    return false;
  }
  if (
    !localModels.transcription.every((model) =>
      isValidLocalModelSelection(model, "transcription")
    ) ||
    !localModels.reasoning.every((model) => isValidLocalModelSelection(model, "reasoning"))
  ) {
    return false;
  }
  const selections = [...localModels.transcription, ...localModels.reasoning];
  if (
    new Set(selections.map((model) => `${model.provider}:${model.modelId}`)).size !==
    selections.length
  ) {
    return false;
  }
  return (
    Number.isSafeInteger(localModels.version) &&
    localModels.version >= 1 &&
    typeof localModels.updatedAt === "string" &&
    !Number.isNaN(Date.parse(localModels.updatedAt)) &&
    (localModels.updatedByUserId === null || isNonEmptyString(localModels.updatedByUserId))
  );
}

function isValidManagedEnterpriseLocalModels(localModels) {
  return localModels !== null && localModels !== undefined && isValidLocalModelsConfig(localModels);
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
  if (!isValidLocalModelsConfig(value.localModels)) return null;
  if (
    value.localModels?.reasoning?.length > 0 &&
    value.providers.some((record) => record.mode !== "disabled")
  ) {
    return null;
  }
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
  return { ...value, generation, localModels: value.localModels ?? null };
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
  isValidManagedEnterpriseLocalModels,
  validateManagedEnterpriseEnvelope,
  resolveManagedEnterpriseScope,
};

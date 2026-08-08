// Structural validation for the org policy delivered by /api/workspace-policy.
// The renderer dereferences policy.<scope>.allowedModes, policy.features.*,
// policy.sharing.*, and policy.dataRetention.* unchecked, and treats a null
// policy as "allow everything" — so a managed response must carry a
// structurally valid policy or the whole response is malformed.
const { isCanonicalAppVersion } = require("./appVersion");
const modelRegistryData = require("../models/modelRegistryData.json");

const POLICY_SCOPES = ["transcription", "llm"];
const TRANSCRIPTION_MODES = new Set(["openwhispr", "providers", "local", "self-hosted"]);
const LLM_MODES = new Set([...TRANSCRIPTION_MODES, "enterprise"]);
const TRANSCRIPTION_PROVIDERS = new Set(
  modelRegistryData.transcriptionProviders.map((provider) => provider.id).concat("custom")
);
const LLM_PROVIDERS = new Set(
  modelRegistryData.cloudProviders.map((provider) => provider.id).concat("custom", "openrouter")
);
const ENTERPRISE_PROVIDERS = new Set(
  modelRegistryData.enterpriseProviders.map((provider) => provider.id)
);
const SHARING_MODES = ["allowed", "domain_only", "disabled"];
const LOCAL_HISTORY_MODES = ["user_choice", "always_on", "always_off"];

function isKnownList(value, known) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && known.has(item));
}

function isValidPolicyShape(policy) {
  return (
    Boolean(policy) &&
    typeof policy === "object" &&
    policy.version === 1 &&
    POLICY_SCOPES.every((scope) => Boolean(policy[scope])) &&
    isKnownList(policy.transcription.allowedModes, TRANSCRIPTION_MODES) &&
    isKnownList(policy.transcription.allowedByokProviders, TRANSCRIPTION_PROVIDERS) &&
    isKnownList(policy.llm.allowedModes, LLM_MODES) &&
    isKnownList(policy.llm.allowedByokProviders, LLM_PROVIDERS) &&
    isKnownList(policy.llm.allowedEnterpriseProviders, ENTERPRISE_PROVIDERS) &&
    typeof policy.features?.agentEnabled === "boolean" &&
    typeof policy.features?.webSearchEnabled === "boolean" &&
    SHARING_MODES.includes(policy.sharing?.externalLinkSharing) &&
    LOCAL_HISTORY_MODES.includes(policy.dataRetention?.localHistoryMode) &&
    typeof policy.dataRetention?.cloudBackupAllowed === "boolean" &&
    (policy.dataRetention?.audioRetentionMaxDays === null ||
      (Number.isSafeInteger(policy.dataRetention?.audioRetentionMaxDays) &&
        policy.dataRetention.audioRetentionMaxDays > 0)) &&
    (policy.minAppVersion === null || isCanonicalAppVersion(policy.minAppVersion))
  );
}

module.exports = { isValidPolicyShape };

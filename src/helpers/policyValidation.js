// Structural validation for the org policy delivered by /api/workspace-policy.
// The renderer dereferences policy.<scope>.allowedModes, policy.features.*,
// policy.sharing.*, and policy.dataRetention.* unchecked, and treats a null
// policy as "allow everything" — so a managed response must carry a
// structurally valid policy or the whole response is malformed.
const { isCanonicalAppVersion } = require("./appVersion");
const modelRegistryData = require("../models/modelRegistryData.json");

const POLICY_SCOPES = ["transcription", "llm"];
const TRANSCRIPTION_MODES = new Set([
  "openwhispr",
  "providers",
  "local",
  "self-hosted",
  "enterprise",
]);
const LLM_MODES = TRANSCRIPTION_MODES;
// Enterprise clouds with a managed transcription implementation (Azure only for now).
const TRANSCRIPTION_ENTERPRISE_PROVIDERS = new Set(["azure"]);
const ENTERPRISE_PROVIDERS = new Set(
  modelRegistryData.enterpriseProviders.map((provider) => provider.id)
);
const SHARING_MODES = ["allowed", "domain_only", "disabled"];
const LOCAL_HISTORY_MODES = ["user_choice", "always_on", "always_off"];

function isKnownList(value, known) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && known.has(item));
}

// Shape-only on purpose, like requiredLocalModels below: a provider id added
// server-side must not make an older app discard the entire managed policy.
// Unknown ids grant nothing — policyRules filters them at enforcement time.
// Modes stay strict: an unknown mode has no fail-closed interpretation.
function isProviderIdList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isValidPolicyShape(policy) {
  return (
    Boolean(policy) &&
    typeof policy === "object" &&
    policy.version === 1 &&
    POLICY_SCOPES.every((scope) => Boolean(policy[scope])) &&
    isKnownList(policy.transcription.allowedModes, TRANSCRIPTION_MODES) &&
    isProviderIdList(policy.transcription.allowedByokProviders) &&
    // Additive within policy version 1: absent (older server) means none.
    (policy.transcription.allowedEnterpriseProviders === undefined ||
      isKnownList(
        policy.transcription.allowedEnterpriseProviders,
        TRANSCRIPTION_ENTERPRISE_PROVIDERS
      )) &&
    isKnownList(policy.llm.allowedModes, LLM_MODES) &&
    isProviderIdList(policy.llm.allowedByokProviders) &&
    isKnownList(policy.llm.allowedEnterpriseProviders, ENTERPRISE_PROVIDERS) &&
    typeof policy.features?.agentEnabled === "boolean" &&
    typeof policy.features?.webSearchEnabled === "boolean" &&
    // Additive within policy version 1: absent (older server) means allowed.
    (policy.features?.screenContextEnabled === undefined ||
      typeof policy.features.screenContextEnabled === "boolean") &&
    SHARING_MODES.includes(policy.sharing?.externalLinkSharing) &&
    LOCAL_HISTORY_MODES.includes(policy.dataRetention?.localHistoryMode) &&
    typeof policy.dataRetention?.cloudBackupAllowed === "boolean" &&
    (policy.dataRetention?.audioRetentionMaxDays === null ||
      (Number.isSafeInteger(policy.dataRetention?.audioRetentionMaxDays) &&
        policy.dataRetention.audioRetentionMaxDays > 0)) &&
    // Shape-only for the same reason as the BYOK provider lists; unknown ids
    // are filtered at enforcement time (see policyRules.requiredLocalModelIds).
    (policy.requiredLocalModels === undefined ||
      (Array.isArray(policy.requiredLocalModels) &&
        policy.requiredLocalModels.every((item) => typeof item === "string"))) &&
    (policy.minAppVersion === null || isCanonicalAppVersion(policy.minAppVersion))
  );
}

module.exports = { isValidPolicyShape };

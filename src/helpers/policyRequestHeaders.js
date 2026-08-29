const { isCanonicalAppVersion } = require("./appVersion");

const POLICY_CAPABILITY_VERSION = "1";

function withPolicyRequestHeaders(headers, appVersion) {
  const version = typeof appVersion === "string" ? appVersion.trim() : appVersion;
  if (!isCanonicalAppVersion(version)) {
    throw new Error("Policy requests require a canonical app version");
  }
  const baseHeaders = headers && typeof headers === "object" ? headers : {};
  return {
    ...baseHeaders,
    "x-openwhispr-policy-version": POLICY_CAPABILITY_VERSION,
    "x-openwhispr-version": version,
  };
}

module.exports = { POLICY_CAPABILITY_VERSION, withPolicyRequestHeaders };

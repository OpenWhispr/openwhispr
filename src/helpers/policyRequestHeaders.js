const { isCanonicalAppVersion } = require("./appVersion");

const POLICY_CAPABILITY_VERSION = "1";
// Features this build can actually run. The server gates Orukeet on this token,
// not on the version alone, so an older build that passes the version gate is
// never handed a route it would silently reroute.
const CLIENT_CAPABILITIES = "orukeet";

function withPolicyRequestHeaders(headers, appVersion) {
  if (!isCanonicalAppVersion(appVersion)) {
    throw new Error("Policy requests require a canonical app version");
  }
  return {
    ...headers,
    "x-openwhispr-policy-version": POLICY_CAPABILITY_VERSION,
    "x-openwhispr-version": appVersion,
    "x-openwhispr-capabilities": CLIENT_CAPABILITIES,
  };
}

module.exports = { CLIENT_CAPABILITIES, POLICY_CAPABILITY_VERSION, withPolicyRequestHeaders };

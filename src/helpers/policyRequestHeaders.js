const { isCanonicalAppVersion } = require("./appVersion");

const POLICY_CAPABILITY_VERSION = "1";
// Features this build can actually run. The server gates Orukeet on this token,
// not on the version alone, so an older build that passes the version gate is
// never handed a route it would silently reroute.
const CLIENT_CAPABILITIES =
  "orukeet,orukeet-pipeline-v2,orukeet-language-routing,enterprise-audio-v1";
// #3030: only the workspace policy lookup asks for the removal signal, so every
// other request's 401 stays the session expiry its caller maps to sign-in.
const WORKSPACE_REMOVAL_CAPABILITY = "workspace-removal-v1";

function withPolicyRequestHeaders(headers, appVersion, extraCapabilities = []) {
  if (!isCanonicalAppVersion(appVersion)) {
    throw new Error("Policy requests require a canonical app version");
  }
  return {
    ...headers,
    "x-openwhispr-policy-version": POLICY_CAPABILITY_VERSION,
    "x-openwhispr-version": appVersion,
    "x-openwhispr-capabilities": [CLIENT_CAPABILITIES, ...extraCapabilities].join(","),
  };
}

module.exports = {
  CLIENT_CAPABILITIES,
  POLICY_CAPABILITY_VERSION,
  WORKSPACE_REMOVAL_CAPABILITY,
  withPolicyRequestHeaders,
};

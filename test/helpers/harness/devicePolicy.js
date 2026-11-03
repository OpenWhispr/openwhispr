const AgentStreamRequestRegistry = require("../../../src/helpers/agentStreamRequestRegistry");

function withDevicePolicy(context) {
  const { session } = require("electron");
  session.defaultSession ??= { cookies: { get: async () => [] } };
  context.managedDevicePolicy = {
    getSnapshot: () => ({ status: "absent", managed: false, policy: null }),
    subscribe: () => () => {},
  };
  context._remoteProductRetirement = new AbortController();
  for (const key of [
    "_agentStreamRequests",
    "_cloudReasonRequests",
    "_cloudTranscriptionRequests",
    "_enterpriseReasoningRequests",
  ]) {
    if (!Object.hasOwn(context, key)) context[key] = new AgentStreamRequestRegistry();
  }
  return context;
}

module.exports = { withDevicePolicy };

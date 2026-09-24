// Connector actions reach outside services, so unlike screen context only a
// successful, well-formed snapshot allows them. Every failure code
// (unresolvable, unavailable, throttled, auth context changed, and any added
// later), a malformed snapshot, and a timeout (null) are "unavailable".
function connectorPolicyState(snapshot) {
  if (!snapshot || snapshot.success !== true || typeof snapshot.managed !== "boolean") {
    return "unavailable";
  }
  if (!snapshot.managed) return "allowed";
  const features = snapshot.policy?.features;
  if (!features || typeof features !== "object") return "unavailable";
  // Connectors are agent tools: an org that turns the agent off turns them off too.
  return features.agentEnabled === false || features.connectorsEnabled === false
    ? "blocked"
    : "allowed";
}

module.exports = { connectorPolicyState };

// Pure (no electron): whether a calendar OAuth client id is present, and the typed
// error the start of the flow throws without one. Fork builds ship no client ids.

function isClientIdConfigured(value) {
  return typeof value === "string" && value.trim() !== "";
}

function notConfiguredError(envName) {
  const error = new Error(`${envName} is not configured`);
  error.code = "not_configured";
  return error;
}

// Throws before any browser or loopback server is opened.
function assertClientIdConfigured(value, envName) {
  if (!isClientIdConfigured(value)) throw notConfiguredError(envName);
}

module.exports = { isClientIdConfigured, notConfiguredError, assertClientIdConfigured };

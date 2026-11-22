// The EnvironmentManager methods ipcHandlers.js calls to read and expand stored
// credentials, for IPC suites that stub the manager. References follow the real
// rules (envRef.cjs, the SECRET_ENV_NAMES allowlist) against `env`, a fake
// environment that holds only test values.
const { envRefName, usableSecret } = require("../../../src/helpers/envRef.cjs");
const { SECRET_ENV_NAMES } = require("../../../src/config/secretKeys");

const ALLOWED = new Set(SECRET_ENV_NAMES);

function secretResolverMethods(env = {}) {
  const resolveSecretRef = (value) => {
    const raw = typeof value === "string" ? value : "";
    const name = envRefName(raw);
    if (!name) return usableSecret(raw);
    if (!ALLOWED.has(name)) return "";
    return usableSecret(env[name]);
  };
  return {
    resolveSecretRef,
    getRawKey: (name) => env[name] || "",
    getRawFieldValue: (name) => env[name] || "",
    onLoginShellImport: () => () => {},
  };
}

module.exports = { secretResolverMethods };

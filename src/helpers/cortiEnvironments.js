/**
 * Corti environment definitions.
 *
 * Each environment maps to:
 *   - region:           used in the auth URL host (https://auth.<region>.corti.app/...)
 *   - defaultTenant:    Keycloak realm name (overridable per-user)
 *   - clientIdEnvVar:   .env variable holding the OAuth public client_id for that environment
 *
 * Adding a new environment is a two-step change:
 *   1. Add an entry here.
 *   2. Set the corresponding CORTI_CLIENT_ID_<ID> in .env.
 */
const CORTI_ENVIRONMENTS = [
  {
    id: "eu",
    label: "EU",
    region: "eu",
    defaultTenant: "base",
    clientIdEnvVar: "CORTI_CLIENT_ID_EU",
  },
  {
    id: "us",
    label: "US",
    region: "us",
    defaultTenant: "base",
    clientIdEnvVar: "CORTI_CLIENT_ID_US",
  },
  {
    // Special-cased: the region comes from a user-entered value
    // (CORTI_CUSTOM_REGION via environmentManager) and the client ID must be
    // supplied by the user — there is no shipped env var to fall back to.
    id: "custom",
    label: "Custom",
    region: "",
    defaultTenant: "base",
    clientIdEnvVar: null,
  },
];

const DEFAULT_ENVIRONMENT_ID = "eu";

function listEnvironments() {
  return CORTI_ENVIRONMENTS.map(({ id, label, region, defaultTenant }) => ({
    id,
    label,
    region,
    defaultTenant,
  }));
}

function getEnvironment(id) {
  return (
    CORTI_ENVIRONMENTS.find((env) => env.id === id) ||
    CORTI_ENVIRONMENTS.find((env) => env.id === DEFAULT_ENVIRONMENT_ID)
  );
}

function isValidEnvironmentId(id) {
  return CORTI_ENVIRONMENTS.some((env) => env.id === id);
}

function getClientIdEnvVars() {
  return CORTI_ENVIRONMENTS.map((env) => env.clientIdEnvVar);
}

module.exports = {
  CORTI_ENVIRONMENTS,
  DEFAULT_ENVIRONMENT_ID,
  listEnvironments,
  getEnvironment,
  isValidEnvironmentId,
  getClientIdEnvVars,
};

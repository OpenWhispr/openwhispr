// Single source of truth for the fork keys that can be overridden per build.
// Used by forkConfig.js (main), forkRuntime.ts (renderer, via Vite's import.meta.env)
// and vite.config.mjs (which snapshots them into dist/runtime-env.json), so the
// three can never drift apart.
const URL_KEYS = ["OPENWHISPR_API_URL", "AUTH_URL"];
const OVERRIDE_KEYS = [
  "ADMIN_URL",
  "SITE_URL",
  "SERVICES_URL",
  "DOCS_URL",
  "MCP_URL",
  "SHARE_VIEWER_URL",
  "SUPPORT_EMAIL",
  "ORUKEET_BASE_URL",
];
const RUNTIME_ENV_KEYS = [...URL_KEYS, ...OVERRIDE_KEYS].map((key) => `VITE_${key}`);

module.exports = { URL_KEYS, OVERRIDE_KEYS, RUNTIME_ENV_KEYS };

// ESM like providerHttpErrors.js: the destinations the agent's open_settings
// tool offers. open-settings-section accepts these and the provider error
// targets (isProviderSettingsTarget), which add noteFormatting.
export const SETTINGS_TARGETS = Object.freeze(
  /** @type {const} */ ([
    "llms",
    "speechToText",
    "privacyData",
    "integrations.connectors",
    "integrations.calendars",
  ])
);

export const isSettingsTarget = (value) => SETTINGS_TARGETS.includes(value);

export const PLANS_BILLING_TARGET = "plansBilling";
export const PLANS_BILLING_WORKSPACE_PREFIX = "plansBilling:workspace:";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const plansBillingTarget = (workspaceId) =>
  `${PLANS_BILLING_WORKSPACE_PREFIX}${workspaceId}`;

// The id is checked as a UUID so a link can't smuggle anything else through the section string.
/** @param {unknown} value @returns {value is string} */
export const isPlansBillingTarget = (value) =>
  typeof value === "string" &&
  (value === PLANS_BILLING_TARGET ||
    (value.startsWith(PLANS_BILLING_WORKSPACE_PREFIX) &&
      UUID_PATTERN.test(value.slice(PLANS_BILLING_WORKSPACE_PREFIX.length))));

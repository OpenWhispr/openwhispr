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

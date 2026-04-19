// Source of truth for the desktop side of the public API key UI.
// Keep API_SCOPES and MAX_API_KEYS in sync with openwhispr-api/lib/api-keys.ts.

export const API_SCOPES = ["notes:read", "notes:write", "transcriptions:read"] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const MAX_API_KEYS = 5;

// Scopes granted to every key but not shown in the UI
const IMPLICIT_SCOPES = ["usage:read"] as const;

export function buildFullScopes(selected: ApiScope[]): string[] {
  return [...selected, ...IMPLICIT_SCOPES];
}

// i18next reserves ":" as the namespace separator, so scope ids can't be used
// as translation keys directly. This map gives each scope an i18n-safe alias.
export const API_SCOPE_I18N_KEY: Record<ApiScope, string> = {
  "notes:read": "notesRead",
  "notes:write": "notesWrite",
  "transcriptions:read": "transcriptionsRead",
};

export interface ApiKeyExpiryOption {
  value: string;
  days: number | null;
}

export const API_KEY_EXPIRY_OPTIONS: readonly ApiKeyExpiryOption[] = [
  { value: "never", days: null },
  { value: "30days", days: 30 },
  { value: "60days", days: 60 },
  { value: "90days", days: 90 },
  { value: "1year", days: 365 },
] as const;

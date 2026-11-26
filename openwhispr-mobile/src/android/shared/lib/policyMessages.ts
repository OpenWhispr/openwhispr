// Single source of truth for the org-policy / client-version rejection
// copy shared across apiClient.ts, TranscriptionService's policyErrors.ts,
// and AgentStreamClient.ts (which hand-rolls its own fetch instead of going
// through apiClient). Deliberately dependency-free: apiClient.ts pulls in
// expo/fetch + useAuthStore (which pulls in better-auth, an ESM-only package
// Jest can't transform), so this constant lives here rather than in
// apiClient.ts to keep the lightweight consumers (like policyErrors.test.ts)
// from having to mock that whole chain just to read a string.

// The server returns this once it can identify the client's version (see
// x-openwhispr-version) and decides it's too old to keep serving cloud
// features. Never let "HTTP 426" or a raw server string reach the user.
export const UPGRADE_REQUIRED_MESSAGE = 'Update OpenWhispr to keep using cloud features.';

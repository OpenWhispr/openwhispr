// Maps org-policy and client-version rejections on the cloud transcription
// endpoints to user-facing errors. Lives in its own module (like
// wordLimit.ts) so tests can exercise the mapping without pulling in the
// native-module-heavy TranscriptionService.
import { UPGRADE_REQUIRED_MESSAGE } from '@/lib/policyMessages';

// Re-exported: existing importers (e.g. this file's own test) read it from
// here. The canonical definition lives in policyMessages.ts, shared with
// apiClient.ts and AgentStreamClient.ts so the copies can't drift.
export { UPGRADE_REQUIRED_MESSAGE };

export const POLICY_MODE_BLOCKED_TRANSCRIPTION_MESSAGE =
  "Your organization's policy doesn't allow OpenWhispr cloud transcription.";

function errorCodeFromBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && typeof parsed.code === 'string'
      ? parsed.code
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps a transcription HTTP response to a user-facing Error, or undefined
 * when the status isn't a recognized policy/version rejection (callers fall
 * through to their existing generic status handling in that case).
 */
export function transcriptionPolicyErrorFromResponse(
  status: number,
  body: string,
): Error | undefined {
  if (status === 403 && errorCodeFromBody(body) === 'POLICY_MODE_BLOCKED') {
    return new Error(POLICY_MODE_BLOCKED_TRANSCRIPTION_MESSAGE);
  }
  if (status === 426) {
    // Never let "HTTP 426" or a raw server string reach the user.
    return new Error(UPGRADE_REQUIRED_MESSAGE);
  }
  return undefined;
}

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

export const MEETING_RECORDING_DISABLED_MESSAGE =
  'Meeting recording is disabled by your organization.';
export const AUDIO_UPLOAD_DISABLED_MESSAGE = 'Audio upload is disabled by your organization.';
// The org restricts audio and the request didn't declare what it was for.
export const AUDIO_PURPOSE_REQUIRED_MESSAGE =
  "Your organization's audio settings need the latest OpenWhispr. Update the app and try again.";

// 403 codes for the org's audio controls.
const AUDIO_POLICY_MESSAGES = new Map([
  ['POLICY_MEETING_RECORDING_DISABLED', MEETING_RECORDING_DISABLED_MESSAGE],
  ['POLICY_AUDIO_UPLOAD_DISABLED', AUDIO_UPLOAD_DISABLED_MESSAGE],
  ['AUDIO_PURPOSE_REQUIRED', AUDIO_PURPOSE_REQUIRED_MESSAGE],
]);

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
  if (status === 403) {
    const code = errorCodeFromBody(body);
    if (code === 'POLICY_MODE_BLOCKED') return new Error(POLICY_MODE_BLOCKED_TRANSCRIPTION_MESSAGE);
    const audioPolicyMessage = code && AUDIO_POLICY_MESSAGES.get(code);
    if (audioPolicyMessage) return new Error(audioPolicyMessage);
  }
  if (status === 426) {
    // Never let "HTTP 426" or a raw server string reach the user.
    return new Error(UPGRADE_REQUIRED_MESSAGE);
  }
  return undefined;
}

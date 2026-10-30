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
// This app always declares a purpose, so reaching it is a client bug: telling
// a user already on the latest version to update would be wrong, and so would
// a retry, which meets the same refusal.
export const AUDIO_PURPOSE_REQUIRED_MESSAGE =
  "This transcription couldn't be checked against your organization's settings. Contact your workspace admin or support.";

// 403 codes for the org's mode and audio controls. Meeting refusals arrive on
// the realtime meeting token (see RealtimeMeetingWsService), upload refusals on
// /api/transcribe. A Map, not a Record, because the key is a server string:
// a code like "constructor" must not read an Object prototype member.
const POLICY_MESSAGES_403: ReadonlyMap<string, string> = new Map([
  ['POLICY_MODE_BLOCKED', POLICY_MODE_BLOCKED_TRANSCRIPTION_MESSAGE],
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

function transcriptionPolicyMessage(status: number, code: string | undefined): string | undefined {
  if (status === 403 && code) {
    const policyMessage = POLICY_MESSAGES_403.get(code);
    if (policyMessage) return policyMessage;
  }
  // Never let "HTTP 426" or a raw server string reach the user.
  if (status === 426) return UPGRADE_REQUIRED_MESSAGE;
  return undefined;
}

type TranscriptionPolicyError = Error & { status: number; code: string | undefined };

// Keeps status and code on the mapped Error: without a status, retry
// strategies read the refusal as a network failure and send it again.
function transcriptionPolicyError(
  status: number,
  code: string | undefined,
): TranscriptionPolicyError | undefined {
  const message = transcriptionPolicyMessage(status, code);
  return message ? Object.assign(new Error(message), { status, code }) : undefined;
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
  // Only a 403 carries a code worth parsing; skip the JSON parse on every success.
  return transcriptionPolicyError(status, status === 403 ? errorCodeFromBody(body) : undefined);
}

/**
 * Same mapping for an apiClient rejection (an ApiError carrying status and
 * code), e.g. the realtime meeting token. Duck-typed so this module stays
 * free of apiClient's import chain.
 */
export function transcriptionPolicyErrorFromApiError(error: unknown): Error | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (typeof status !== 'number') return undefined;
  return transcriptionPolicyError(status, typeof code === 'string' ? code : undefined);
}

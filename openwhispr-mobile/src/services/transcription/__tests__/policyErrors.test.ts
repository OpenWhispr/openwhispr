import {
  AUDIO_PURPOSE_REQUIRED_MESSAGE,
  AUDIO_UPLOAD_DISABLED_MESSAGE,
  MEETING_RECORDING_DISABLED_MESSAGE,
  POLICY_MODE_BLOCKED_TRANSCRIPTION_MESSAGE,
  UPGRADE_REQUIRED_MESSAGE,
  transcriptionPolicyErrorFromApiError,
  transcriptionPolicyErrorFromResponse,
} from '../policyErrors';

describe('transcriptionPolicyErrorFromResponse', () => {
  it('maps 403 + POLICY_MODE_BLOCKED to the exact user-facing message', () => {
    const error = transcriptionPolicyErrorFromResponse(
      403,
      JSON.stringify({ error: 'blocked', code: 'POLICY_MODE_BLOCKED' }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(POLICY_MODE_BLOCKED_TRANSCRIPTION_MESSAGE);
    expect(POLICY_MODE_BLOCKED_TRANSCRIPTION_MESSAGE).toBe(
      "Your organization's policy doesn't allow OpenWhispr cloud transcription.",
    );
  });

  it.each([
    ['POLICY_MEETING_RECORDING_DISABLED', MEETING_RECORDING_DISABLED_MESSAGE],
    ['POLICY_AUDIO_UPLOAD_DISABLED', AUDIO_UPLOAD_DISABLED_MESSAGE],
    ['AUDIO_PURPOSE_REQUIRED', AUDIO_PURPOSE_REQUIRED_MESSAGE],
  ])('maps 403 + %s to its own message, never the raw server text', (code, message) => {
    const error = transcriptionPolicyErrorFromResponse(
      403,
      JSON.stringify({ error: 'raw server text', code }),
    );
    expect(error?.message).toBe(message);
  });

  it('keeps status and code on the mapped error so retries treat it as terminal', () => {
    expect(
      transcriptionPolicyErrorFromResponse(
        403,
        JSON.stringify({ error: 'raw server text', code: 'POLICY_AUDIO_UPLOAD_DISABLED' }),
      ),
    ).toMatchObject({ status: 403, code: 'POLICY_AUDIO_UPLOAD_DISABLED' });
    expect(transcriptionPolicyErrorFromResponse(426, '')).toMatchObject({ status: 426 });
  });

  it('neither tells the user to update the app nor to retry when the purpose is missing', () => {
    expect(AUDIO_PURPOSE_REQUIRED_MESSAGE).not.toMatch(/update/i);
    expect(AUDIO_PURPOSE_REQUIRED_MESSAGE).not.toMatch(/try again/i);
  });

  it('names the disabled control in the audio refusal messages', () => {
    expect(MEETING_RECORDING_DISABLED_MESSAGE).toBe(
      'Meeting recording is disabled by your organization.',
    );
    expect(AUDIO_UPLOAD_DISABLED_MESSAGE).toBe('Audio upload is disabled by your organization.');
  });

  it('leaves an ordinary 403 (no POLICY_MODE_BLOCKED code) unmapped', () => {
    expect(
      transcriptionPolicyErrorFromResponse(403, JSON.stringify({ error: 'Forbidden' })),
    ).toBeUndefined();
  });

  it('leaves a 403 with an unrelated code unmapped', () => {
    expect(
      transcriptionPolicyErrorFromResponse(
        403,
        JSON.stringify({ error: 'nope', code: 'SOME_OTHER_CODE' }),
      ),
    ).toBeUndefined();
  });

  it('leaves a non-JSON 403 body unmapped', () => {
    expect(transcriptionPolicyErrorFromResponse(403, 'Forbidden')).toBeUndefined();
  });

  it('maps 426 to the exact upgrade message regardless of body content', () => {
    const error = transcriptionPolicyErrorFromResponse(426, 'some raw server string');
    expect(error?.message).toBe(UPGRADE_REQUIRED_MESSAGE);
    expect(UPGRADE_REQUIRED_MESSAGE).toBe('Update OpenWhispr to keep using cloud features.');
  });

  it('maps 426 even with an empty body', () => {
    expect(transcriptionPolicyErrorFromResponse(426, '')?.message).toBe(UPGRADE_REQUIRED_MESSAGE);
  });

  it('never surfaces "HTTP 426" text', () => {
    const error = transcriptionPolicyErrorFromResponse(426, JSON.stringify({ error: 'HTTP 426' }));
    expect(error?.message).not.toMatch(/HTTP 426/);
  });

  it('leaves other statuses (200, 401, 429, 500) unmapped', () => {
    expect(transcriptionPolicyErrorFromResponse(200, '{}')).toBeUndefined();
    expect(transcriptionPolicyErrorFromResponse(401, '{}')).toBeUndefined();
    expect(transcriptionPolicyErrorFromResponse(429, '{}')).toBeUndefined();
    expect(transcriptionPolicyErrorFromResponse(500, '{}')).toBeUndefined();
  });
});

describe('transcriptionPolicyErrorFromApiError', () => {
  const apiError = (status: number, code?: string): Error =>
    Object.assign(new Error('raw server text'), { status, code });

  it.each([
    ['POLICY_MEETING_RECORDING_DISABLED', MEETING_RECORDING_DISABLED_MESSAGE],
    ['POLICY_MODE_BLOCKED', POLICY_MODE_BLOCKED_TRANSCRIPTION_MESSAGE],
  ])('maps 403 + %s to its message, keeping status and code', (code, message) => {
    const error = transcriptionPolicyErrorFromApiError(apiError(403, code));
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message, status: 403, code });
  });

  it('maps 426 to the upgrade message', () => {
    expect(transcriptionPolicyErrorFromApiError(apiError(426))?.message).toBe(
      UPGRADE_REQUIRED_MESSAGE,
    );
  });

  it('leaves unrelated codes, other statuses, and status-less errors unmapped', () => {
    expect(transcriptionPolicyErrorFromApiError(apiError(403, 'SOME_OTHER_CODE'))).toBeUndefined();
    expect(
      transcriptionPolicyErrorFromApiError(apiError(400, 'INVALID_AUDIO_PURPOSE')),
    ).toBeUndefined();
    expect(transcriptionPolicyErrorFromApiError(new Error('network down'))).toBeUndefined();
    expect(transcriptionPolicyErrorFromApiError('nope')).toBeUndefined();
  });
});

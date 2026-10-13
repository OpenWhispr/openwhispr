import { toFriendlyTranscriptionErrorMessage } from '../transcriptionErrors';

describe('toFriendlyTranscriptionErrorMessage', () => {
  it('maps the offline NSURL upload error to a connection message', () => {
    const raw =
      'Unable to upload the file: \'Error Domain=NSURLErrorDomain Code=-1009 "The internet connection appears to be offline."\'';
    expect(toFriendlyTranscriptionErrorMessage(new Error(raw))).toBe(
      'No internet connection. Check your connection and try again.',
    );
  });

  it('maps a timed-out request to a timeout message', () => {
    expect(
      toFriendlyTranscriptionErrorMessage(
        new Error('Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."'),
      ),
    ).toBe('The request timed out. Check your connection and try again.');
  });

  it('maps a web fetch failure to the offline message', () => {
    expect(toFriendlyTranscriptionErrorMessage(new TypeError('Network request failed'))).toBe(
      'No internet connection. Check your connection and try again.',
    );
  });

  it('maps unreadable-audio module codes to a format hint', () => {
    const error = Object.assign(new Error('transcode failed'), { code: 'AUDIO_TRANSCODE_ERROR' });
    expect(toFriendlyTranscriptionErrorMessage(error)).toBe(
      "Couldn't read this audio file. Please try a WAV, MP3, or M4A file.",
    );
  });

  it('passes already-friendly messages through untouched', () => {
    for (const message of [
      'Session expired. Please sign in again.',
      'Weekly word limit reached',
      'Audio is too large for cloud transcription. Please record a shorter clip or upload a smaller file.',
    ]) {
      expect(toFriendlyTranscriptionErrorMessage(new Error(message))).toBe(message);
    }
  });

  it('falls back to a generic line for empty or raw platform dumps', () => {
    expect(toFriendlyTranscriptionErrorMessage(new Error(''))).toBe(
      'Something went wrong. Please try again.',
    );
    expect(
      toFriendlyTranscriptionErrorMessage('{"error":{"domain":"weird"},"stack":"<native>"}'),
    ).toBe('Something went wrong. Please try again.');
  });
});

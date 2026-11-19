import { bubbleFailure, bubbleMode } from '../bubbleOutcome';
import { WordLimitError } from '@/services/transcription/wordLimit';
import { AccountRequiredError } from '@/lib/accountRequiredError';

const messages = {
  noSpeech: 'We didn’t hear anything.',
  speechDownloadNeeded: 'Download the speech model.',
  textDownloadNeeded: 'Download the text model.',
};

describe('bubbleFailure: each failure gets its own status tab', () => {
  it.each([
    ['silence the recorder flagged', new Error('anything'), true, 'no-speech', false],
    ['silence the pipeline found', new Error(messages.noSpeech), false, 'no-speech', false],
    [
      'the weekly word limit',
      new WordLimitError('Weekly word limit reached'),
      false,
      'out-of-words',
      false,
    ],
    [
      'a 429 from another transport',
      Object.assign(new Error('Too many'), { status: 429 }),
      false,
      'out-of-words',
      false,
    ],
    ['a guest refused by the server', new AccountRequiredError(), false, 'sign-in', false],
    [
      'a missing speech model',
      new Error(messages.speechDownloadNeeded),
      false,
      'model-needed',
      false,
    ],
    ['a missing text model', new Error(messages.textDownloadNeeded), false, 'model-needed', false],
    ['no network', new TypeError('Network request failed'), false, 'offline', true],
    ['a timeout', new Error('The request timed out'), false, 'offline', true],
    ['anything else', new Error('Server error 500'), false, 'failed', true],
  ])('%s', (_name, error, noSpeech, message, keep) => {
    expect(bubbleFailure(error, noSpeech, messages)).toEqual({ message, keep });
  });
});

describe('bubbleMode', () => {
  it('passes the menu modes through and dictates otherwise', () => {
    expect(bubbleMode('write', '')).toBe('write');
    expect(bubbleMode('translate', 'x')).toBe('translate');
    expect(bubbleMode('edit', 'x')).toBe('edit');
    expect(bubbleMode('edit', '')).toBe('write');
    expect(bubbleMode('dictate', 'x')).toBe('dictate');
    expect(bubbleMode(undefined, '')).toBe('dictate');
  });
});

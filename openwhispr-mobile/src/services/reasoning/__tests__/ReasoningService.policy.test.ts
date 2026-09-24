jest.mock('@/lib/apiClient', () => ({
  api: {
    post: jest.fn(),
  },
}));

import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { api } from '@/lib/apiClient';

const mockPost = api.post as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('ReasoningService POLICY_MODE_BLOCKED mapping', () => {
  it('maps a 403 + POLICY_MODE_BLOCKED api.post rejection to the exact user-facing message', async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error('server said no'), { status: 403, code: 'POLICY_MODE_BLOCKED' }),
    );

    await expect(ReasoningService.processText({ text: 'hi', language: 'en' })).rejects.toThrow(
      "Your organization's policy doesn't allow OpenWhispr cloud AI.",
    );
  });

  it('leaves an ordinary 403 (no POLICY_MODE_BLOCKED code) untouched', async () => {
    const original = Object.assign(new Error('Forbidden'), { status: 403 });
    mockPost.mockRejectedValue(original);

    await expect(ReasoningService.processText({ text: 'hi', language: 'en' })).rejects.toBe(
      original,
    );
  });

  it('leaves a 403 with an unrelated code untouched', async () => {
    const original = Object.assign(new Error('Forbidden'), { status: 403, code: 'OTHER_CODE' });
    mockPost.mockRejectedValue(original);

    await expect(ReasoningService.processText({ text: 'hi', language: 'en' })).rejects.toBe(
      original,
    );
  });

  it('leaves non-403 errors (e.g. 500) untouched', async () => {
    const original = Object.assign(new Error('Server error'), {
      status: 500,
      code: 'POLICY_MODE_BLOCKED',
    });
    mockPost.mockRejectedValue(original);

    await expect(ReasoningService.processText({ text: 'hi', language: 'en' })).rejects.toBe(
      original,
    );
  });

  it('applies the same mapping to chatOverNote', async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error('server said no'), { status: 403, code: 'POLICY_MODE_BLOCKED' }),
    );

    await expect(
      ReasoningService.chatOverNote({
        context: 'note body',
        question: 'what happened?',
        history: [],
      }),
    ).rejects.toThrow("Your organization's policy doesn't allow OpenWhispr cloud AI.");
  });
});

jest.mock('@/lib/apiClient', () => ({
  api: { post: jest.fn() },
}));

import { api } from '@/lib/apiClient';
import { createStripeBillingPortalSession } from '../billingApi';

const mockPost = api.post as jest.Mock;

describe('billingApi', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it('creates a billing portal session with no body and returns the url', async () => {
    mockPost.mockResolvedValue({
      url: 'https://billing.stripe.com/p/session',
      provider: 'stripe',
    });

    const url = await createStripeBillingPortalSession();

    expect(mockPost).toHaveBeenCalledWith('/api/stripe/portal');
    expect(url).toBe('https://billing.stripe.com/p/session');
  });

  it.each([
    ['missing provider', { url: 'https://billing.stripe.com/p/session' }],
    ['wrong provider', { url: 'https://billing.stripe.com/p/session', provider: 'paddle' }],
    ['missing URL', { provider: 'stripe' }],
    ['empty URL', { url: '', provider: 'stripe' }],
    ['blank URL', { url: '   ', provider: 'stripe' }],
  ])('rejects a portal response with %s', async (_label, response) => {
    mockPost.mockResolvedValue(response);

    await expect(createStripeBillingPortalSession()).rejects.toThrow(
      'Invalid Stripe billing portal response',
    );
  });
});

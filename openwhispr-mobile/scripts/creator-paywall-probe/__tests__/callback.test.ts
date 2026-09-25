import { createProbeCallback, probeParams, PROBE_TOKEN } from '../callback';

afterEach(() => jest.useRealTimers());
it('reports only shape and returns visibly fictional display data', async () => {
  jest.useFakeTimers();
  const shape = jest.fn();
  const probe = createProbeCallback(shape);
  const result = probe.handle({
    name: 'creatorCodeApply',
    variables: { input: 'DEMO_ONLY', secret: 'do-not-echo', selectedIndex: 1 },
  });
  await jest.advanceTimersByTimeAsync(701);
  expect(await result).toEqual({
    status: 'success',
    data: {
      priceText: 'TEST $7.99',
      renewalText: expect.stringContaining('fictional'),
      offerToken: PROBE_TOKEN,
    },
  });
  expect(JSON.stringify(shape.mock.calls)).not.toContain('do-not-echo');
});
it.each(['missing', 'malformed', 'failure'] as const)(
  'provides the %s fixture without services',
  async (scenario) => {
    jest.useFakeTimers();
    const result = createProbeCallback(jest.fn(), scenario).handle({
      name: 'creatorCodeApply',
      variables: { input: 'DEMO_ONLY' },
    });
    await jest.advanceTimersByTimeAsync(701);
    const response = await result;
    if (scenario === 'failure') expect(response.status).toBe('failure');
    else if (scenario === 'missing') expect(response.data).not.toHaveProperty('offerToken');
    else expect(response.data).toHaveProperty('priceText', 799);
  },
);
it('seeds only fictional display data and no redemption URL', () => {
  expect(probeParams('seed')).toMatchObject({
    creator_offer_ready: true,
    creator_offer_token: PROBE_TOKEN,
  });
  expect(probeParams('seed-missing').creator_offer_token).toBe('');
  expect(probeParams('valid')).toMatchObject({
    creator_offer_ready: false,
    creator_offer_price: '',
    creator_offer_renewal: '',
    creator_offer_token: '',
  });
  expect(JSON.stringify(probeParams('seed'))).not.toContain('https:');
});
it('does not return an offer after dismissal', async () => {
  jest.useFakeTimers();
  const probe = createProbeCallback(jest.fn());
  const result = probe.handle({ name: 'creatorCodeApply', variables: { input: 'DEMO_ONLY' } });
  probe.close();
  await jest.advanceTimersByTimeAsync(701);
  expect(await result).toEqual({ status: 'failure' });
});
it.each(['creatorOfferRedeem', 'unknown'])('refuses %s even with fixture input', async (name) => {
  expect(
    (await createProbeCallback(jest.fn()).handle({ name, variables: { input: 'DEMO_ONLY' } }))
      .status,
  ).toBe('failure');
});
it('refuses customer-looking input', async () => {
  expect(
    (
      await createProbeCallback(jest.fn()).handle({
        name: 'creatorCodeApply',
        variables: { input: 'somecreator' },
      })
    ).status,
  ).toBe('failure');
});

it('returns a missing token on same-presentation retry after a valid offer', async () => {
  jest.useFakeTimers();
  const probe = createProbeCallback(jest.fn(), 'retry-missing');
  const callback = { name: 'creatorCodeApply', variables: { input: 'DEMO_ONLY' } };
  const first = probe.handle(callback);
  await jest.advanceTimersByTimeAsync(701);
  expect((await first).data).toHaveProperty('offerToken', PROBE_TOKEN);
  const next = probe.handle(callback);
  await jest.advanceTimersByTimeAsync(701);
  expect((await next).data).not.toHaveProperty('offerToken');
});

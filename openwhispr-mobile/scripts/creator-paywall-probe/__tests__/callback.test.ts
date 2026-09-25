import { createProbeCallback } from '../callback';

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
    data: { priceText: 'TEST $7.99', renewalText: expect.stringContaining('fictional') },
  });
  expect(JSON.stringify(shape.mock.calls)).not.toContain('do-not-echo');
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

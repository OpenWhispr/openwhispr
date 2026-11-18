function loadBridge(platform: 'ios' | 'android', native: Record<string, unknown> = {}) {
  jest.resetModules();
  const requireNativeModule = jest.fn(() => native);
  jest.doMock('expo', () => ({ requireNativeModule }));
  jest.doMock('react-native', () => ({ Platform: { OS: platform } }));
  const { BackgroundUploader } = require(
    platform === 'android' ? '../index.android' : '../index',
  ) as typeof import('../index');
  return { BackgroundUploader, requireNativeModule };
}

afterEach(() => {
  jest.dontMock('expo');
  jest.dontMock('react-native');
  jest.resetModules();
});

it('keeps the upstream iOS unavailable-provider error', async () => {
  const { BackgroundUploader, requireNativeModule } = loadBridge('ios');
  expect(requireNativeModule).toHaveBeenCalledWith('BackgroundUploader');
  await expect(
    BackgroundUploader.requestProvider({
      requestId: 'fixture',
      method: 'POST',
      url: 'https://example.invalid',
    }),
  ).rejects.toMatchObject({
    message: 'Provider requests require an updated iOS native build',
    code: 'PROVIDER_TRANSPORT_UNAVAILABLE',
  });
});

it('retains Android provider request, cancellation and recovery forwarding', async () => {
  const result = { status: 200, body: 'fixture', url: 'https://example.invalid', headers: {} };
  const native = {
    requestProvider: jest.fn().mockResolvedValue(result),
    cancelProviderRequest: jest.fn(),
    listProviderRecoveryJobIds: jest.fn(() => ['fixture-job']),
    clearProviderRecovery: jest.fn(),
  };
  const { BackgroundUploader, requireNativeModule } = loadBridge('android', native);
  expect(requireNativeModule).toHaveBeenCalledTimes(1);
  expect(requireNativeModule).toHaveBeenCalledWith('AndroidDictation');
  const options = {
    requestId: 'fixture-job',
    method: 'POST' as const,
    url: 'https://example.invalid',
  };
  await expect(BackgroundUploader.requestProvider(options)).resolves.toBe(result);
  expect(native.requestProvider).toHaveBeenCalledWith(options);
  BackgroundUploader.cancelProviderRequest('fixture-job');
  expect(native.cancelProviderRequest).toHaveBeenCalledWith('fixture-job');
  expect(BackgroundUploader.listProviderRecoveryJobIds()).toEqual(['fixture-job']);
  expect(BackgroundUploader.clearProviderRecovery('fixture-job')).toBe(true);
  expect(native.clearProviderRecovery).toHaveBeenCalledWith('fixture-job');
  expect(BackgroundUploader.isAvailable()).toBe(false);
  await expect(
    BackgroundUploader.upload({ url: 'https://example.invalid', fileUri: 'file:///fixture' }),
  ).rejects.toThrow('BackgroundUploader is only available on iOS');
});

it('retains Android missing-provider fallbacks', async () => {
  const { BackgroundUploader } = loadBridge('android');
  expect(BackgroundUploader.listProviderRecoveryJobIds()).toEqual([]);
  expect(BackgroundUploader.clearProviderRecovery('fixture-job')).toBe(false);
  expect(() => BackgroundUploader.cancelProviderRequest('fixture-job')).not.toThrow();
  await expect(
    BackgroundUploader.requestProvider({
      requestId: 'fixture',
      method: 'POST',
      url: 'https://example.invalid',
    }),
  ).rejects.toMatchObject({
    message: 'Provider requests require an updated native build',
    code: 'PROVIDER_TRANSPORT_UNAVAILABLE',
  });
});

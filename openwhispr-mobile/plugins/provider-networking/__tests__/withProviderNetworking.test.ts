export {};

jest.mock('expo/config-plugins', () => ({
  withInfoPlist: (config: unknown, action: (value: unknown) => unknown) => action(config),
}));
const withProviderNetworking = require('../withProviderNetworking');

it('declares local networking without broad insecure HTTP exceptions', () => {
  const result = withProviderNetworking({ modResults: { CFBundleName: 'OpenWhispr' } });
  expect(result.modResults.CFBundleName).toBe('OpenWhispr');
  expect(result.modResults.NSLocalNetworkUsageDescription).toContain('local network');
  expect(result.modResults.NSAppTransportSecurity).toEqual({ NSAllowsLocalNetworking: true });
});

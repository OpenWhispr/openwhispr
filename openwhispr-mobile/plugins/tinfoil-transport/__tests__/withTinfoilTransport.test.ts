export {};
const mockRead = jest.fn();
const mockWrite = jest.fn();
jest.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => mockRead(...args),
  writeFileSync: (...args: unknown[]) => mockWrite(...args),
}));
jest.mock('expo/config-plugins', () => ({
  withDangerousMod: (config: unknown, [, action]: [string, (value: unknown) => unknown]) =>
    action(config),
}));
const withTinfoilTransport = require('../withTinfoilTransport');
beforeEach(() => jest.clearAllMocks());
it('updates an existing SDK revision instead of silently retaining an obsolete verifier', async () => {
  mockRead.mockReturnValue(
    'platform :ios, "17.0"\nspm_pkg "tinfoil-swift", :products => ["TinfoilAI"], :git => "https://github.com/tinfoilsh/tinfoil-swift.git", :commit => "old-pin"\n',
  );
  await withTinfoilTransport({ modRequest: { platformProjectRoot: '/fixture/ios' } });
  expect(mockWrite).toHaveBeenCalledWith(
    '/fixture/ios/Podfile',
    expect.stringContaining(':commit => "4988b05e124dc217b5e5e9fef6c9e95e5355eeea"'),
  );
  expect(mockWrite.mock.calls[0][1]).not.toContain('old-pin');
});

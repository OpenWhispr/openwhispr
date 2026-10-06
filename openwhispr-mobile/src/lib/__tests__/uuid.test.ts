describe('randomUUID', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('expo-crypto');
  });

  it('returns the UUID produced by Expo Crypto', () => {
    const nativeUUID = 'ac028740-f771-4e64-bde7-f0c334e4d653';
    jest.doMock('expo-crypto', () => ({ randomUUID: () => nativeUUID }));
    const { randomUUID } = require('../uuid') as typeof import('../uuid');

    expect(randomUUID()).toBe(nativeUUID);
  });

  it.each([undefined, null, ''])('fails closed when Expo Crypto returns %p', (value) => {
    jest.doMock('expo-crypto', () => ({ randomUUID: () => value }));
    const { randomUUID } = require('../uuid') as typeof import('../uuid');
    const insecureRandom = jest.spyOn(Math, 'random');

    let failure: unknown;
    try {
      randomUUID();
    } catch (error) {
      failure = error;
    }
    const insecureCalls = insecureRandom.mock.calls.length;
    insecureRandom.mockRestore();

    expect(failure).toEqual(new Error('Secure UUID generation is unavailable'));
    expect(insecureCalls).toBe(0);
  });

  it('propagates native failures without falling back to insecure randomness', () => {
    const nativeError = new Error('Native crypto unavailable');
    jest.doMock('expo-crypto', () => ({
      randomUUID: () => {
        throw nativeError;
      },
    }));
    const { randomUUID } = require('../uuid') as typeof import('../uuid');
    const insecureRandom = jest.spyOn(Math, 'random');

    let failure: unknown;
    try {
      randomUUID();
    } catch (error) {
      failure = error;
    }
    const insecureCalls = insecureRandom.mock.calls.length;
    insecureRandom.mockRestore();

    expect(failure).toBe(nativeError);
    expect(insecureCalls).toBe(0);
  });
});

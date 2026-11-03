const mockCachedBindings = new Map<string, { released: boolean }>();
const mockOpen = jest.fn((name: string, options?: { useNewConnection?: boolean }) => {
  let binding = options?.useNewConnection ? undefined : mockCachedBindings.get(name);
  if (!binding) {
    binding = { released: false };
    if (!options?.useNewConnection) mockCachedBindings.set(name, binding);
  }
  const retained = binding;
  return {
    execSync: () => {
      if (retained.released) throw new Error('Native binding released');
    },
    releaseNativeBinding: () => {
      retained.released = true;
    },
  };
});

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: (...args: Parameters<typeof mockOpen>) => mockOpen(...args),
}));

beforeEach(() => {
  jest.resetModules();
  mockOpen.mockClear();
  mockCachedBindings.clear();
  require('react-native').Platform.OS = 'android';
});

it('retains distinct usable account handles when their files are selected again', () => {
  const { openApplicationDatabase } = require('../connections');
  const accountA = openApplicationDatabase('account-a.db');
  const accountB = openApplicationDatabase('account-b.db');
  expect(accountA).not.toBe(accountB);
  for (let i = 0; i < 5; i++) {
    expect(openApplicationDatabase('account-a.db')).toBe(accountA);
    expect(openApplicationDatabase('account-b.db')).toBe(accountB);
    expect(() => accountA.execSync()).not.toThrow();
    expect(() => accountB.execSync()).not.toThrow();
  }
});

it('does not inherit a native cached binding released by an earlier JS handle', () => {
  const old = mockOpen('account-a.db');
  old.releaseNativeBinding();
  expect(() => mockOpen('account-a.db').execSync()).toThrow('Native binding released');

  const { openApplicationDatabase } = require('../connections');
  const current = openApplicationDatabase('account-a.db');
  expect(() => current.execSync()).not.toThrow();
});

it('allows a failed open to be retried without keeping a broken handle', () => {
  mockOpen.mockImplementationOnce(() => {
    throw new Error('Open failed');
  });
  const { openApplicationDatabase } = require('../connections');
  expect(() => openApplicationDatabase('account-a.db')).toThrow('Open failed');
  expect(() => openApplicationDatabase('account-a.db').execSync()).not.toThrow();
});

it('preserves the existing iOS open behavior', () => {
  require('react-native').Platform.OS = 'ios';
  const { openApplicationDatabase } = require('../connections');
  const first = openApplicationDatabase('openwhispr_notes.db');
  const second = openApplicationDatabase('openwhispr_notes.db');
  expect(first).not.toBe(second);
  expect(mockOpen.mock.calls).toEqual([['openwhispr_notes.db'], ['openwhispr_notes.db']]);
});

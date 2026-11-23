import {
  buildKeyboardDirectConfig,
  startKeyboardDirectSync,
  type KeyboardDirectInputs,
} from '@/lib/keyboardDirectSync';

// The pure rule and the sync loop are tested here; gathering from the stores is glue the
// device checklist covers.
jest.mock('@/lib/keyboardDirectInputs', () => ({ gatherKeyboardDirectInputs: jest.fn() }));
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { setItem: jest.fn(() => true) },
  APP_GROUP_KEYS: { KEYBOARD_DIRECT_CONFIG: 'keyboard_direct_config' },
}));

function inputs(overrides: Partial<KeyboardDirectInputs> = {}): KeyboardDirectInputs {
  return {
    settingEnabled: true,
    userId: 'u1',
    hasSessionCookie: true,
    route: { provider: 'cloud', cleanupMode: 'openwhispr', cleanupUnavailable: false },
    cleanupEnabled: true,
    customCleanupPrompt: false,
    cloudTranscriptionAllowed: true,
    overWordLimit: false,
    apiBaseUrl: 'https://api.openwhispr.com',
    appVersion: '1.2.6',
    language: 'en',
    toneApplies: true,
    dictionary: {
      personal: ['Kubernetes', 'my email'],
      shared: ['Gizmo'],
      prompt: 'Kubernetes, Gizmo',
    },
    snippets: [{ trigger: 'my email', replacement: 'a@b.co' }],
    ...overrides,
  };
}

describe('buildKeyboardDirectConfig', () => {
  it('enables the path when every condition holds', () => {
    expect(buildKeyboardDirectConfig(inputs())).toEqual({
      version: 1,
      enabled: true,
      disabledReason: null,
      userId: 'u1',
      apiBaseUrl: 'https://api.openwhispr.com',
      appVersion: '1.2.6',
      language: 'en',
      cleanup: { enabled: true, language: 'en', toneApplies: true },
      dictionary: {
        personal: ['Kubernetes', 'my email'],
        shared: ['Gizmo'],
        prompt: 'Kubernetes, Gizmo',
      },
      snippets: [{ trigger: 'my email', replacement: 'a@b.co' }],
    });
  });

  it.each<[string, Partial<KeyboardDirectInputs>]>([
    ['setting_off', { settingEnabled: false }],
    ['signed_out', { userId: null }],
    ['signed_out', { hasSessionCookie: false }],
    ['not_cloud', { route: null }],
    [
      'not_cloud',
      { route: { provider: 'byok', cleanupMode: 'openwhispr', cleanupUnavailable: false } },
    ],
    [
      'not_cloud',
      { route: { provider: 'local', cleanupMode: 'local', cleanupUnavailable: false } },
    ],
    [
      'not_cloud',
      { route: { provider: 'cloud', cleanupMode: 'local', cleanupUnavailable: false } },
    ],
    [
      'not_cloud',
      { route: { provider: 'cloud', cleanupMode: 'providers', cleanupUnavailable: false } },
    ],
    [
      'not_cloud',
      { route: { provider: 'cloud', cleanupMode: 'openwhispr', cleanupUnavailable: true } },
    ],
    ['custom_prompt', { customCleanupPrompt: true }],
    ['policy', { cloudTranscriptionAllowed: false }],
    ['word_limit', { overWordLimit: true }],
  ])('disables with %s', (reason, overrides) => {
    const config = buildKeyboardDirectConfig(inputs(overrides));
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe(reason);
  });

  it('reports the first failing condition in order', () => {
    expect(
      buildKeyboardDirectConfig(inputs({ settingEnabled: false, userId: null })).disabledReason,
    ).toBe('setting_off');
    expect(
      buildKeyboardDirectConfig(
        inputs({ route: null, customCleanupPrompt: true, overWordLimit: true }),
      ).disabledReason,
    ).toBe('not_cloud');
    expect(
      buildKeyboardDirectConfig(
        inputs({ customCleanupPrompt: true, cloudTranscriptionAllowed: false }),
      ).disabledReason,
    ).toBe('custom_prompt');
  });

  it('keeps Cloud dictation with cleanup off eligible, whatever cleanup is routed to', () => {
    const config = buildKeyboardDirectConfig(
      inputs({
        cleanupEnabled: false,
        customCleanupPrompt: true,
        route: { provider: 'cloud', cleanupMode: 'local', cleanupUnavailable: true },
      }),
    );
    expect(config.enabled).toBe(true);
    expect(config.cleanup).toEqual({ enabled: false, language: 'en', toneApplies: true });
  });

  it('carries nothing personal when the path is off', () => {
    const config = buildKeyboardDirectConfig(inputs({ route: null }));
    expect(config.userId).toBeNull();
    expect(config.dictionary).toEqual({ personal: [], shared: [], prompt: '' });
    expect(config.snippets).toEqual([]);
  });

  it('sends no language when none is set', () => {
    const config = buildKeyboardDirectConfig(inputs({ language: null }));
    expect(config.language).toBeNull();
    expect(config.cleanup.language).toBeNull();
  });
});

describe('startKeyboardDirectSync', () => {
  function harness(initial: KeyboardDirectInputs) {
    let current = initial;
    const listeners: (() => void)[] = [];
    const written: string[] = [];
    const stop = startKeyboardDirectSync({
      gather: () => current,
      subscribe: (listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
      write: (json) => {
        written.push(json);
        return true;
      },
    });
    return {
      written,
      stop,
      change(next: Partial<KeyboardDirectInputs>) {
        current = { ...current, ...next };
        listeners.forEach((listener) => listener());
      },
    };
  }

  it('writes the snapshot on start', () => {
    const sync = harness(inputs());
    expect(sync.written).toHaveLength(1);
    expect(JSON.parse(sync.written[0])).toMatchObject({ version: 1, enabled: true, userId: 'u1' });
    sync.stop();
  });

  it('rewrites when the setting flips', () => {
    const sync = harness(inputs());
    sync.change({ settingEnabled: false });
    expect(sync.written).toHaveLength(2);
    expect(JSON.parse(sync.written[1])).toMatchObject({
      enabled: false,
      disabledReason: 'setting_off',
    });
    sync.stop();
  });

  it('does not rewrite an identical snapshot', () => {
    const sync = harness(inputs());
    sync.change({ appVersion: '1.2.6' });
    sync.change({});
    expect(sync.written).toHaveLength(1);
    sync.stop();
  });

  it('stops after unsubscribe', () => {
    const sync = harness(inputs());
    sync.stop();
    sync.change({ settingEnabled: false });
    expect(sync.written).toHaveLength(1);
  });
});

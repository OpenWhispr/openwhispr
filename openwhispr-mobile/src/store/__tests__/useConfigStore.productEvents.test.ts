import type { UserConfig } from '@/types';

let mockQueueDisk = new Map<string, string>();
let mockFailPurge = false;
let mockPurgeHold: Promise<void> | null = null;
let mockOnline = false;
let mockAnonymous = true;
const mockDelivered: { path: string; events?: { event_id: string; event_name: string }[] }[] = [];

jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.1.0' } } }));
jest.mock('@/lib/apiClient', () => ({
  BASE_URL: 'https://api.example.test',
  getClientVersionHeader: () => ({}),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      user: { id: 'account-1', isAnonymous: mockAnonymous },
      sessionCookie: 'session-1',
      isGuest: false,
    }),
    subscribe: () => () => undefined,
  },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string): Promise<string | null> => mockQueueDisk.get(key) ?? null,
    setItem: async (key: string, value: string): Promise<void> => {
      const next = JSON.parse(value) as { events: unknown[] };
      const previous = JSON.parse(mockQueueDisk.get(key) ?? '{"events":[]}') as {
        events: unknown[];
      };
      if (next.events.length === 0 && previous.events.length > 0) {
        if (mockFailPurge) throw new Error('Queue storage unavailable');
        await mockPurgeHold;
      }
      mockQueueDisk.set(key, value);
    },
  },
}));
jest.mock('expo/fetch', () => ({
  fetch: async (url: string, options: { body: string }): Promise<unknown> => {
    if (!mockOnline) throw new Error('Offline');
    const body = JSON.parse(options.body) as {
      events?: { event_id: string; event_name: string }[];
    };
    mockDelivered.push({ path: url, ...body });
    return {
      status: 200,
      json: async () =>
        url.endsWith('/app-session')
          ? {
              binding_id: '0d6b9a52-7a3c-4c8e-9f1d-2b4a6c8e0f13',
              authenticated_at: '2026-11-04T08:00:00.000Z',
            }
          : { accepted: body.events?.map((event) => event.event_id) ?? [] },
    };
  },
}));

const CONFIG_KEY = '@openwhispr:user_config';
const QUEUE_KEY = 'openwhispr_product_events';
const COMPLETION = { mode: 'private' as const, replay: false, flowVersion: 'mobile-onboarding-3' };
const enabledConfig: UserConfig = {
  defaultMode: 'cloud',
  localModeUpgraded: true,
  noteChatSplit: true,
  notesLocalModeSplit: true,
  usageAnalyticsEnabled: true,
};

let configDisk: Map<string, string>;
let failConfigSave: boolean;
let failConfigRead: boolean;

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function savedConfig(): UserConfig {
  return JSON.parse(configDisk.get(CONFIG_KEY) ?? '{}') as UserConfig;
}

function queuedIds(): string[] {
  const queue = JSON.parse(mockQueueDisk.get(QUEUE_KEY) ?? '{"events":[]}') as {
    events: { event_id: string }[];
  };
  return queue.events.map((event) => event.event_id);
}

function deliveredIds(): string[] {
  return mockDelivered.flatMap((request) => request.events?.map((event) => event.event_id) ?? []);
}

function launch(): {
  store: typeof import('../useConfigStore').useConfigStore;
  productEvents: typeof import('@/lib/productEvents');
} {
  jest.resetModules();
  jest.clearAllTimers();
  const { useConfigStore } = require('../useConfigStore') as typeof import('../useConfigStore');
  const productEvents = require('@/lib/productEvents') as typeof import('@/lib/productEvents');
  return { store: useConfigStore, productEvents };
}

async function queueMilestone(): Promise<ReturnType<typeof launch>> {
  const app = launch();
  app.productEvents.initProductEvents();
  await app.store.getState().loadConfig();
  await settle();
  app.productEvents.recordOnboardingCompleted(COMPLETION);
  await settle();
  expect(queuedIds()).toHaveLength(1);
  return app;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  mockQueueDisk = new Map();
  mockFailPurge = false;
  mockPurgeHold = null;
  mockOnline = false;
  mockAnonymous = true;
  mockDelivered.length = 0;
  configDisk = new Map([[CONFIG_KEY, JSON.stringify(enabledConfig)]]);
  failConfigSave = false;
  failConfigRead = false;
  globalThis.localStorage = {
    getItem: (key: string): string | null => {
      if (failConfigRead) throw new Error('Config storage unavailable');
      return configDisk.get(key) ?? null;
    },
    setItem: (key: string, value: string): void => {
      if (failConfigSave) throw new Error('Config storage unavailable');
      configDisk.set(key, value);
    },
    removeItem: (key: string): void => {
      if (failConfigSave) throw new Error('Config storage unavailable');
      configDisk.delete(key);
    },
    clear: (): void => configDisk.clear(),
    key: (index: number): string | null => [...configDisk.keys()][index] ?? null,
    get length(): number {
      return configDisk.size;
    },
  };
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('persisted Usage Analytics consent', () => {
  it('keeps consent off after a failed purge so a restart cannot upload the old queue', async () => {
    const app = await queueMilestone();
    const oldIds = queuedIds();
    mockFailPurge = true;

    await app.store.getState().updateConfig({ usageAnalyticsEnabled: false });
    await settle();
    await app.store.getState().updateConfig({ usageAnalyticsEnabled: true });
    await settle();

    expect(savedConfig().usageAnalyticsEnabled).toBe(false);
    expect(app.store.getState().config?.usageAnalyticsEnabled).toBe(false);
    expect(app.store.getState().error).toBeTruthy();
    expect(queuedIds()).toEqual(oldIds);

    mockFailPurge = false;
    mockOnline = true;
    const restarted = launch();
    restarted.productEvents.initProductEvents();
    await restarted.store.getState().loadConfig();
    await settle();

    expect(deliveredIds()).toEqual([]);
    expect(queuedIds()).toEqual([]);
    await restarted.store.getState().updateConfig({ usageAnalyticsEnabled: true });
    await settle();
    expect(deliveredIds()).toEqual([]);
  });

  it('keeps a rapid off/on persisted off while erasure is pending across a restart', async () => {
    const app = await queueMilestone();
    let releasePurge!: () => void;
    mockPurgeHold = new Promise((resolve) => {
      releasePurge = resolve;
    });

    const disabling = app.store.getState().updateConfig({ usageAnalyticsEnabled: false });
    const enabling = app.store.getState().updateConfig({ usageAnalyticsEnabled: true });
    await settle();

    expect(savedConfig().usageAnalyticsEnabled).toBe(false);
    expect(queuedIds()).toHaveLength(1);

    mockPurgeHold = null;
    mockOnline = true;
    const restarted = launch();
    restarted.productEvents.initProductEvents();
    await restarted.store.getState().loadConfig();
    await settle();
    expect(deliveredIds()).toEqual([]);
    expect(queuedIds()).toEqual([]);

    releasePurge();
    await Promise.all([disabling, enabling]);
    await settle();
  });

  it('does not let a concurrent unrelated config save restore consent after opt-out', async () => {
    const app = await queueMilestone();
    mockFailPurge = true;

    await Promise.all([
      app.store.getState().updateConfig({ usageAnalyticsEnabled: false }),
      app.store.getState().updateConfig({ cleanupEnabled: true }),
    ]);

    expect(savedConfig()).toMatchObject({ usageAnalyticsEnabled: false, cleanupEnabled: true });
    expect(app.store.getState().config?.usageAnalyticsEnabled).toBe(false);
  });

  it('purges before re-enabling even when the collector has not initialized', async () => {
    await queueMilestone();
    configDisk.set(CONFIG_KEY, JSON.stringify({ ...enabledConfig, usageAnalyticsEnabled: false }));
    const restarted = launch();
    await restarted.store.getState().loadConfig();
    mockFailPurge = true;

    await restarted.store.getState().updateConfig({ usageAnalyticsEnabled: true });

    expect(savedConfig().usageAnalyticsEnabled).toBe(false);
    expect(restarted.store.getState().error).toBeTruthy();
  });

  it('prevents Reset from restoring the enabled default when erasure fails', async () => {
    const app = await queueMilestone();
    mockFailPurge = true;
    await app.store.getState().updateConfig({ usageAnalyticsEnabled: false });

    await app.store.getState().resetConfig();

    expect(savedConfig().usageAnalyticsEnabled).toBe(false);
    expect(app.store.getState().config?.usageAnalyticsEnabled).toBe(false);
    expect(app.store.getState().error).toBeTruthy();
  });

  it('keeps analytics off when a restart cannot read the saved opt-out', async () => {
    const app = await queueMilestone();
    mockFailPurge = true;
    await app.store.getState().updateConfig({ usageAnalyticsEnabled: false });
    await settle();
    mockFailPurge = false;
    failConfigRead = true;
    mockOnline = true;

    const restarted = launch();
    restarted.productEvents.initProductEvents();
    await restarted.store.getState().loadConfig();
    await settle();

    expect(mockDelivered).toEqual([]);
    expect(restarted.store.getState().config?.usageAnalyticsEnabled).toBe(false);
    expect(restarted.store.getState().error).toBeTruthy();
  });

  it('re-enables the held account after erasure and only uploads newly recorded milestones', async () => {
    const app = await queueMilestone();
    const oldIds = queuedIds();
    await app.store.getState().updateConfig({ usageAnalyticsEnabled: false });
    mockAnonymous = false;
    mockOnline = true;

    await app.store.getState().updateConfig({ usageAnalyticsEnabled: true });
    await settle();
    app.productEvents.recordOnboardingCompleted(COMPLETION);
    await settle();

    expect(savedConfig().usageAnalyticsEnabled).toBe(true);
    expect(app.store.getState().error).toBeNull();
    expect(mockDelivered.map((request) => request.path)).toContain(
      'https://api.example.test/api/product-events/app-session',
    );
    expect(
      mockDelivered.flatMap((request) => request.events?.map((event) => event.event_name) ?? []),
    ).toEqual(['app_session_authenticated', 'onboarding_completed']);
    expect(deliveredIds()).not.toEqual(expect.arrayContaining(oldIds));
    expect(queuedIds()).toEqual([]);
  });

  it('retains the saved opt-out if the opt-in config save fails after erasure', async () => {
    const app = await queueMilestone();
    await app.store.getState().updateConfig({ usageAnalyticsEnabled: false });
    failConfigSave = true;
    mockOnline = true;

    await app.store.getState().updateConfig({ usageAnalyticsEnabled: true });
    await settle();

    expect(savedConfig().usageAnalyticsEnabled).toBe(false);
    expect(app.store.getState().config?.usageAnalyticsEnabled).toBe(false);
    expect(app.store.getState().error).toBeTruthy();
    expect(mockDelivered).toEqual([]);
    expect(queuedIds()).toEqual([]);

    failConfigSave = false;
    const restarted = launch();
    restarted.productEvents.initProductEvents();
    await restarted.store.getState().loadConfig();
    await restarted.store.getState().updateConfig({ usageAnalyticsEnabled: true });
    await settle();
    expect(savedConfig().usageAnalyticsEnabled).toBe(true);
    expect(deliveredIds()).toEqual([]);
  });

  it('retains a queue while consent is unknown and uploads it when enabled config hydrates', async () => {
    await queueMilestone();
    const retainedIds = queuedIds();
    mockOnline = true;
    const restarted = launch();
    restarted.productEvents.initProductEvents();
    await settle();

    expect(mockDelivered).toEqual([]);
    expect(queuedIds()).toEqual(retainedIds);
    await restarted.store.getState().loadConfig();
    await settle();
    expect(deliveredIds()).toEqual(retainedIds);
    expect(queuedIds()).toEqual([]);
  });
});

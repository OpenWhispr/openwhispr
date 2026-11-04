import {
  PRODUCT_EVENT_CAPABILITIES,
  createProductEvents,
  type ProductEventsIdentity,
  type ProductEventsResponse,
} from '../productEvents';

// jest-expo implements neither generator; dictation ids are a SHA-256 of the capture id.
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string): Promise<string> =>
    jest.requireActual('node:crypto').createHash('sha256').update(value).digest('hex'),
  randomUUID: jest.requireActual('node:crypto').randomUUID,
}));

const BINDING = '0d6b9a52-7a3c-4c8e-9f1d-2b4a6c8e0f13';
const AUTHENTICATED_AT = '2026-11-04T08:00:00.000Z';
const ANONYMOUS: ProductEventsIdentity = { userId: 'anon-1', isAnonymous: true, cookie: 'c-anon' };
const ACCOUNT: ProductEventsIdentity = { userId: 'acct-a', isAnonymous: false, cookie: 'c-a1' };
const OTHER: ProductEventsIdentity = { userId: 'acct-b', isAnonymous: false, cookie: 'c-b1' };

interface Call {
  path: string;
  body: {
    collector?: Record<string, unknown>;
    events?: { event_id: string; event_name: string; occurred_at: string; properties: unknown }[];
  } & Record<string, unknown>;
  cookie: string;
  /** False for an attempt that never reached the server. */
  delivered: boolean;
}

function rig(storage = memoryStorage(), { allowed: initiallyAllowed = true } = {}) {
  let identity: ProductEventsIdentity | null = null;
  let allowed = initiallyAllowed;
  let onboarding = false;
  let now = Date.parse('2026-11-04T08:00:05.000Z');
  const calls: Call[] = [];
  const timers: (() => void)[] = [];
  const server = {
    batchStatus: 200,
    batchCode: null as string | null,
    bindStatus: 200,
    bindingId: BINDING,
    offline: false,
    defer: new Set<string>(),
    // Runs after the server answered, before the client reads the answer.
    afterAnswer: null as (() => void) | null,
    // Holds the next batch request open until it settles.
    hold: null as Promise<void> | null,
  };
  const request = async (path: string, body: unknown, cookie: string) => {
    if (server.hold && path.endsWith('/batch')) {
      const hold = server.hold;
      server.hold = null;
      await hold;
    }
    calls.push({
      path,
      body: structuredClone(body) as Call['body'],
      cookie,
      delivered: !server.offline,
    });
    if (server.offline) throw new Error('Network request failed');
    let response: ProductEventsResponse;
    if (path.endsWith('/app-session')) {
      response =
        server.bindStatus === 200
          ? {
              status: 200,
              body: { binding_id: server.bindingId, authenticated_at: AUTHENTICATED_AT },
            }
          : { status: server.bindStatus, body: { code: 'ANONYMOUS_SESSION' } };
    } else if (server.batchStatus !== 200) {
      response = { status: server.batchStatus, body: { code: server.batchCode } };
    } else {
      const ids = ((body as Call['body']).events ?? []).map((event) => event.event_id);
      response = {
        status: 200,
        body: { accepted: ids.filter((id) => !server.defer.has(id)) },
      };
    }
    server.afterAnswer?.();
    return response;
  };
  const events = createProductEvents({
    storage,
    getIdentity: () => identity,
    isAllowed: () => allowed,
    isOnboarding: () => onboarding,
    request,
    os: 'ios',
    appVersion: '1.2.6',
    now: () => now,
    setTimer: (callback) => {
      timers.push(callback);
    },
  });
  return {
    events,
    calls,
    timers,
    server,
    storage,
    signInAs: async (next: ProductEventsIdentity | null) => {
      identity = next;
      await events.observeIdentity();
    },
    setIdentityQuietly: (next: ProductEventsIdentity | null) => {
      identity = next;
    },
    setUsageAnalytics: async (next: boolean) => {
      allowed = next;
      await events.observeConsent();
    },
    setUsageAnalyticsQuietly: (next: boolean) => {
      allowed = next;
    },
    setOnboarding: (value: boolean) => {
      onboarding = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    batches: () => calls.filter((call) => call.path.endsWith('/batch')),
    sentEvents: () =>
      calls.flatMap((call) =>
        call.path.endsWith('/batch') && call.delivered
          ? (call.body.events ?? []).map((event) => ({ ...event, cookie: call.cookie }))
          : [],
      ),
    queued: () => storage.queued(),
  };
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      items.set(key, value);
    },
    queued: () =>
      (
        JSON.parse(items.get('openwhispr_product_events') ?? '{"events":[]}') as {
          events: {
            event_id: string;
            event_name: string;
            owner_user_id: string;
            properties: Record<string, unknown>;
          }[];
        }
      ).events,
  };
}

const COMPLETION = { mode: 'private' as const, replay: false, flowVersion: 'mobile-onboarding-3' };

describe('mobile product events', () => {
  it('binds a real session it accepts and uploads the sign-in timed by the server', async () => {
    const r = rig();
    await r.signInAs(ACCOUNT);

    const [bind, upload] = r.calls;
    expect(bind.path).toBe('/api/product-events/app-session');
    expect(bind.cookie).toBe('c-a1');
    expect(bind.body).toEqual({
      surface: 'mobile',
      os: 'ios',
      installation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      app_version: '1.2.6',
    });
    expect(upload.body.collector).toMatchObject({
      surface: 'mobile',
      os: 'ios',
      installation_id: bind.body.installation_id,
      capabilities: PRODUCT_EVENT_CAPABILITIES,
    });
    expect(upload.body.events).toEqual([
      {
        event_id: BINDING,
        event_name: 'app_session_authenticated',
        schema_version: 1,
        occurred_at: AUTHENTICATED_AT,
        app_version: '1.2.6',
        flow_version: null,
        identity_generation: 1,
        properties: { binding_id: BINDING },
      },
    ]);
    expect(r.queued()).toEqual([]);
  });

  it('an anonymous onboarding session is no sign-in', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);

    expect(r.calls.filter((call) => call.path.endsWith('/app-session'))).toEqual([]);
  });

  it('a session the store reports again (refetch, re-render, restore) binds once', async () => {
    const r = rig();
    await r.signInAs(ACCOUNT);
    await r.signInAs(ACCOUNT);
    await r.events.observeIdentity();

    expect(r.calls.filter((call) => call.path.endsWith('/app-session'))).toHaveLength(1);
  });

  it('an offline launch binds nothing, and binds when the session is next accepted', async () => {
    const r = rig();
    r.server.offline = true;
    await r.signInAs(ACCOUNT);
    expect(r.queued()).toEqual([]);

    r.server.offline = false;
    await r.signInAs(null);
    await r.signInAs(ACCOUNT);
    expect(r.sentEvents().map((event) => event.event_id)).toEqual([BINDING]);
  });

  it('a binding answer that arrives after an account switch is not queued for anyone', async () => {
    const r = rig();
    r.server.afterAnswer = () => r.setIdentityQuietly(OTHER);
    await r.signInAs(ACCOUNT);

    expect(r.queued()).toEqual([]);
  });

  it('anonymous onboarding uploads while still anonymous, on the anonymous session', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);
    await r.events.recordOnboardingCompleted(COMPLETION);

    const [sent] = r.sentEvents();
    expect(sent).toMatchObject({
      event_name: 'onboarding_completed',
      occurred_at: '2026-11-04T08:00:05.000Z',
      properties: { replay: false, setup_mode: 'local' },
      cookie: 'c-anon',
    });
    expect(r.queued()).toEqual([]);
  });

  it('onboarding finished offline while anonymous uploads after the sign-up it linked into', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);
    r.server.offline = true;
    await r.events.recordOnboardingCompleted(COMPLETION);
    r.server.offline = false;
    r.advance(60 * 60_000);

    // Signing up from the anonymous session: the server links the two.
    await r.signInAs(ACCOUNT);

    const onboarding = r.sentEvents().find((event) => event.event_name === 'onboarding_completed');
    expect(onboarding).toMatchObject({ occurred_at: '2026-11-04T08:00:05.000Z', cookie: 'c-a1' });
    expect(r.queued()).toEqual([]);
  });

  it('an anonymous session that signed out first never hands its events to the next account', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);
    r.server.offline = true;
    await r.events.recordOnboardingCompleted(COMPLETION);
    r.server.offline = false;

    await r.signInAs(null);
    await r.signInAs(ACCOUNT);

    expect(r.sentEvents().map((event) => event.event_name)).toEqual(['app_session_authenticated']);
    expect(r.queued().map((event) => event.owner_user_id)).toEqual(['anon-1']);
  });

  it("account A's queued events never upload under B, and go when A is back", async () => {
    const r = rig();
    await r.signInAs(ACCOUNT);
    r.server.batchStatus = 503;
    await r.events.recordOnboardingCompleted({ ...COMPLETION, mode: 'cloud' });
    r.server.batchStatus = 200;

    // Every binding is its own server-made id.
    r.server.bindingId = '7a1c2e3d-4b5f-4a6e-8c7d-9e0f1a2b3c4d';
    await r.signInAs(OTHER);
    const asB = r.batches().filter((call) => call.cookie === 'c-b1');
    expect(asB.flatMap((call) => call.body.events ?? []).map((event) => event.event_name)).toEqual([
      'app_session_authenticated',
    ]);

    await r.signInAs({ ...ACCOUNT, cookie: 'c-a2' });
    const asA = r.sentEvents().filter((event) => event.cookie === 'c-a2');
    expect(asA.map((event) => event.event_name)).toContain('onboarding_completed');
    expect(r.queued()).toEqual([]);
  });

  it('an upload answer for a session no longer held does not settle the queue', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);
    r.server.afterAnswer = () => r.setIdentityQuietly(null);
    await r.events.recordOnboardingCompleted(COMPLETION);

    expect(r.queued()).toHaveLength(1);
  });

  it('a 503 is retried later and keeps the capture time', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);
    r.server.batchStatus = 503;
    await r.events.recordOnboardingCompleted(COMPLETION);
    expect(r.timers).toHaveLength(1);

    r.server.batchStatus = 200;
    r.advance(24 * 60 * 60_000);
    r.timers[0]();
    await r.events.flush();
    expect(r.sentEvents().at(-1)?.occurred_at).toBe('2026-11-04T08:00:05.000Z');
    expect(r.queued()).toEqual([]);
  });

  it('only accepted ids leave the queue: a deferred event stays for the next upload', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);
    r.server.defer.add(BINDING);
    r.server.bindingId = BINDING;
    await r.events.recordOnboardingCompleted(COMPLETION);
    await r.signInAs(ACCOUNT);

    expect(r.queued().map((event) => event.event_id)).toEqual([BINDING]);
    r.server.defer.clear();
    await r.events.recordOnboardingCompleted({ ...COMPLETION, replay: true });
    expect(r.queued()).toEqual([]);
  });

  it('a policy block leaves the account unobserved and stops posting for that session', async () => {
    const r = rig();
    r.server.batchStatus = 403;
    r.server.batchCode = 'POLICY_CLOUD_BACKUP_BLOCKED';
    r.server.bindStatus = 403;
    await r.signInAs(ACCOUNT);
    await r.events.recordOnboardingCompleted(COMPLETION);
    await r.events.recordOnboardingCompleted(COMPLETION);

    // Nothing is posted again, and nothing retried, until the session changes.
    expect(r.batches()).toHaveLength(1);
    expect(r.timers).toEqual([]);
  });

  it('reports coverage once per session with nothing queued', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);
    await r.events.flush();
    await r.events.flush();

    expect(r.batches().map((call) => call.body.events)).toEqual([[]]);
  });

  it('with Usage Analytics off, a sign-in and an onboarding send and keep nothing', async () => {
    const r = rig(memoryStorage(), { allowed: false });
    await r.signInAs(ANONYMOUS);
    await r.events.recordOnboardingCompleted(COMPLETION);
    await r.signInAs(ACCOUNT);
    await r.events.flush();

    // No binding, no upload and no coverage: the account reads as unobserved.
    expect(r.calls).toEqual([]);
    expect(r.queued()).toEqual([]);
  });

  it('turning Usage Analytics off drops what is still queued', async () => {
    const r = rig();
    await r.signInAs(ACCOUNT);
    r.server.offline = true;
    await r.events.recordOnboardingCompleted(COMPLETION);
    expect(r.queued()).toHaveLength(1);

    await r.setUsageAnalytics(false);
    r.server.offline = false;
    await r.events.flush();

    expect(r.queued()).toEqual([]);
    expect(r.sentEvents().map((event) => event.event_name)).toEqual(['app_session_authenticated']);
  });

  it('turned on later (or once the saved config loads), the session held then is observed', async () => {
    const r = rig(memoryStorage(), { allowed: false });
    await r.signInAs(ACCOUNT);
    expect(r.calls).toEqual([]);

    await r.setUsageAnalytics(true);

    expect(r.calls.map((call) => call.path)).toEqual([
      '/api/product-events/app-session',
      '/api/product-events/batch',
    ]);
    expect(r.sentEvents().map((event) => event.event_id)).toEqual([BINDING]);
  });

  it('a binding answer that arrives after Usage Analytics went off is not queued', async () => {
    const r = rig();
    r.server.afterAnswer = () => r.setUsageAnalyticsQuietly(false);
    await r.signInAs(ACCOUNT);

    expect(r.queued()).toEqual([]);
    expect(r.batches()).toEqual([]);
  });

  it('a guest without a session records nothing', async () => {
    const r = rig();
    await r.events.recordOnboardingCompleted(COMPLETION);

    expect(r.calls).toEqual([]);
    expect(r.queued()).toEqual([]);
  });

  it('a sign-in the server took is not uploaded again when a relaunch restores the session', async () => {
    const storage = memoryStorage();
    const first = rig(storage);
    await first.signInAs(ACCOUNT);
    expect(first.sentEvents().map((event) => event.event_id)).toEqual([BINDING]);

    const relaunched = rig(storage);
    await relaunched.signInAs(ACCOUNT);
    expect(relaunched.calls.filter((call) => call.path.endsWith('/app-session'))).toHaveLength(1);
    expect(relaunched.sentEvents()).toEqual([]);
    expect(relaunched.queued()).toEqual([]);
  });

  it('an event queued while an upload is in flight goes in a follow-up pass', async () => {
    const r = rig();
    let release!: () => void;
    r.server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The session's coverage call is still in flight when onboarding completes.
    r.setIdentityQuietly(ANONYMOUS);
    const observing = r.events.observeIdentity();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completing = r.events.recordOnboardingCompleted(COMPLETION);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([observing, completing]);
    // Nothing else asks for a pass: the follow-up has to start on its own.
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      r.batches().map((call) => (call.body.events ?? []).map((event) => event.event_name)),
    ).toEqual([[], ['onboarding_completed']]);
    expect(r.queued()).toEqual([]);
  });

  it('keeps its installation id and queue across a relaunch, and drops what is too old', async () => {
    const storage = memoryStorage();
    const first = rig(storage);
    await first.signInAs(ANONYMOUS);
    first.server.offline = true;
    await first.events.recordOnboardingCompleted(COMPLETION);
    const installation = await first.events.installationId();

    const relaunched = rig(storage);
    expect(await relaunched.events.installationId()).toBe(installation);
    expect(relaunched.queued()).toHaveLength(1);

    relaunched.advance(31 * 24 * 60 * 60_000);
    await relaunched.signInAs(ANONYMOUS);
    expect(relaunched.sentEvents()).toEqual([]);
    expect(relaunched.queued()).toEqual([]);
  });
});

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function dictation(
  n: number,
  words: number | null,
  overrides: Partial<
    Parameters<ReturnType<typeof rig>['events']['recordDictationCompleted']>[0]
  > = {},
) {
  return {
    captureId: `recording-${n}`,
    words,
    provider: 'cloud' as const,
    source: 'dictation' as const,
    retranscribe: false,
    ...overrides,
  };
}

function queuedDictation(r: ReturnType<typeof rig>) {
  return r
    .queued()
    .filter((event) => event.event_name === 'dictation_completed')
    .map((event) => [
      event.properties.word_count,
      event.properties.is_practice,
      event.properties.is_retranscribe,
    ]);
}

describe('mobile dictation', () => {
  it('uploads a finished dictation as its word count under the account, never its text', async () => {
    const r = rig();
    await r.signInAs(ACCOUNT);
    await r.events.recordDictationCompleted(dictation(1, 12, { provider: 'local' }));

    const sent = r.sentEvents().filter((event) => event.event_name === 'dictation_completed');
    expect(sent).toEqual([
      {
        event_id: expect.stringMatching(UUID_V8),
        event_name: 'dictation_completed',
        schema_version: 1,
        occurred_at: '2026-11-04T08:00:05.000Z',
        app_version: '1.2.6',
        flow_version: null,
        identity_generation: 1,
        properties: {
          word_count: 12,
          counter_version: 2,
          mode: 'local',
          source: 'dictation',
          is_practice: false,
          is_retranscribe: false,
        },
        cookie: 'c-a1',
      },
    ]);
    expect(PRODUCT_EVENT_CAPABILITIES).toContain('dictation_completed');
    expect(r.batches().at(-1)?.body.collector?.capabilities).toEqual(PRODUCT_EVENT_CAPABILITIES);
    expect(r.queued()).toEqual([]);
  });

  it('one recording is one event, however often and on whichever device run it is reported', async () => {
    const storage = memoryStorage();
    const first = rig(storage);
    await first.signInAs(ACCOUNT);
    first.server.offline = true;
    await first.events.recordDictationCompleted(dictation(1, 150, { source: 'keyboard' }));
    await first.events.recordDictationCompleted(dictation(1, 150, { source: 'keyboard' }));
    expect(queuedDictation(first)).toEqual([[150, false, false]]);

    // The id comes from the capture alone, so a relaunch reporting it again names it the same.
    const relaunched = rig(memoryStorage());
    await relaunched.signInAs(ACCOUNT);
    relaunched.server.offline = true;
    await relaunched.events.recordDictationCompleted(dictation(1, 150));
    expect(relaunched.queued()[0].event_id).toBe(first.queued()[0].event_id);
  });

  it('an anonymous onboarding session records no dictation: words before sign-up never count', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);
    await r.events.recordDictationCompleted(dictation(1, 250));

    expect(r.queued()).toEqual([]);
    expect(r.sentEvents()).toEqual([]);
  });

  it('a guest without a session records no dictation', async () => {
    const r = rig();
    await r.events.recordDictationCompleted(dictation(1, 250));

    expect(r.calls).toEqual([]);
    expect(r.queued()).toEqual([]);
  });

  it("199 and then 1 word are both recorded, and nothing after this device's first 200", async () => {
    const r = rig();
    await r.signInAs(ACCOUNT);
    r.server.offline = true;
    await r.events.recordDictationCompleted(dictation(4, 0));
    await r.events.recordDictationCompleted(dictation(1, 199));
    await r.events.recordDictationCompleted(dictation(2, 1));
    await r.events.recordDictationCompleted(dictation(3, 40));

    expect(queuedDictation(r)).toEqual([
      [199, false, false],
      [1, false, false],
    ]);
  });

  it('onboarding practice and a re-transcription are recorded as such and never bring the 200 closer', async () => {
    const r = rig();
    await r.signInAs(ACCOUNT);
    r.server.offline = true;
    r.setOnboarding(true);
    await r.events.recordDictationCompleted(dictation(1, 180, { source: 'keyboard' }));
    r.setOnboarding(false);
    await r.events.recordDictationCompleted(dictation(2, 150, { retranscribe: true }));
    await r.events.recordDictationCompleted(dictation(3, 150));
    await r.events.recordDictationCompleted(dictation(4, 50));
    await r.events.recordDictationCompleted(dictation(5, 1));

    expect(queuedDictation(r)).toEqual([
      [180, true, false],
      [150, false, true],
      [150, false, false],
      [50, false, false],
    ]);
  });

  it("a dictation this device can't count goes up once per account, marking its 200 words uncertain", async () => {
    const r = rig();
    await r.signInAs(ACCOUNT);
    r.server.offline = true;
    r.setOnboarding(true);
    await r.events.recordDictationCompleted(dictation(1, null));
    r.setOnboarding(false);
    await r.events.recordDictationCompleted(dictation(2, null));
    await r.events.recordDictationCompleted(dictation(3, null));
    await r.events.recordDictationCompleted(dictation(4, 120));

    expect(queuedDictation(r)).toEqual([
      [null, true, false],
      [null, false, false],
      [120, false, false],
    ]);
  });

  it("dictation keeps its account through a switch, and goes only under that account's session", async () => {
    const r = rig();
    await r.signInAs(ACCOUNT);
    r.server.offline = true;
    await r.events.recordDictationCompleted(dictation(1, 150));
    r.server.offline = false;
    r.server.batchStatus = 503;
    await r.signInAs(OTHER);
    await r.events.recordDictationCompleted(dictation(2, 120));
    r.server.batchStatus = 200;
    await r.events.flush();

    // Sent twice, the first answered 503: always B's own, always on B's session.
    const sent = r.sentEvents().filter((event) => event.event_name === 'dictation_completed');
    expect([
      ...new Set(
        sent.map(
          (event) => `${(event.properties as { word_count: number }).word_count} ${event.cookie}`,
        ),
      ),
    ]).toEqual(['120 c-b1']);
    expect(r.queued().map((event) => event.owner_user_id)).toEqual(['acct-a']);
  });

  it('with Usage Analytics off, no dictation is recorded, even one that finished as it went off', async () => {
    const r = rig(memoryStorage(), { allowed: false });
    await r.signInAs(ACCOUNT);
    await r.events.recordDictationCompleted(dictation(1, 120));
    expect(r.queued()).toEqual([]);

    await r.setUsageAnalytics(true);
    r.server.offline = true;
    const finishing = r.events.recordDictationCompleted(dictation(2, 60));
    r.setUsageAnalyticsQuietly(false);
    await finishing;
    expect(r.queued()).toEqual([]);
    expect(r.sentEvents().filter((event) => event.event_name === 'dictation_completed')).toEqual(
      [],
    );
  });

  it('a policy block drops queued dictation and queues none while the session lasts', async () => {
    const r = rig();
    await r.signInAs(ACCOUNT);
    r.server.offline = true;
    await r.events.recordDictationCompleted(dictation(1, 120));
    r.server.offline = false;
    r.server.batchStatus = 403;
    r.server.batchCode = 'POLICY_CLOUD_BACKUP_BLOCKED';
    await r.events.flush();
    expect(r.queued()).toEqual([]);

    await r.events.recordDictationCompleted(dictation(2, 60));
    expect(r.queued()).toEqual([]);
  });
});

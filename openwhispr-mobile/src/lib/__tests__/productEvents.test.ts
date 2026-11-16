import {
  PRODUCT_EVENT_CAPABILITIES,
  createProductEvents,
  type ProductEventsCaptureContext,
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
    linkedAccounts: new Map<string, string>(),
    legacyBatch: false,
    offline: false,
    defer: new Set<string>(),
    reject: new Set<string>(),
    duplicate: new Set<string>(),
    // Runs after the server answered, before the client reads the answer.
    afterAnswer: null as (() => void) | null,
    // Holds the next batch request open until it settles.
    hold: null as Promise<void> | null,
  };
  const request = async (path: string, body: unknown, cookie: string) => {
    const batch = body as Call['body'];
    if (server.hold && path.endsWith('/batch')) {
      const hold = server.hold;
      server.hold = null;
      await hold;
    }
    calls.push({
      path,
      body: structuredClone(batch),
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
    } else if (
      server.legacyBatch &&
      ('expected_user_id' in batch || 'anonymous_source_user_id' in batch)
    ) {
      response = { status: 400, body: { code: 'INVALID_REQUEST' } };
    } else if (server.batchStatus !== 200) {
      response = { status: server.batchStatus, body: { code: server.batchCode } };
    } else {
      const origin = batch.anonymous_source_user_id;
      const linkedAccount = typeof origin === 'string' ? server.linkedAccounts.get(origin) : null;
      if (origin && linkedAccount !== cookie) {
        response = linkedAccount
          ? { status: 409, body: { code: 'PRODUCT_EVENTS_LINK_MISMATCH' } }
          : { status: 503, body: { code: 'PRODUCT_EVENTS_LINK_PENDING' } };
      } else {
        const ids = (batch.events ?? []).map((event) => event.event_id);
        const accepted = ids.filter((id) => !server.defer.has(id));
        response = {
          status: 200,
          body: {
            accepted,
            stored: accepted.filter((id) => !server.reject.has(id) && !server.duplicate.has(id)),
            duplicates: accepted.filter((id) => server.duplicate.has(id) && !server.reject.has(id)),
            conflicts: [],
            rejected: accepted
              .filter((id) => server.reject.has(id))
              .map((event_id) => ({ event_id, reason: 'before_opt_in' })),
          },
        };
      }
    }
    server.afterAnswer?.();
    return response;
  };
  const events = createProductEvents({
    storage,
    getIdentity: () => identity,
    getConsent: () => allowed,
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
    events: {
      ...events,
      recordDictationCompleted: (
        completion: Omit<Parameters<typeof events.recordDictationCompleted>[0], 'context'> & {
          context?: ProductEventsCaptureContext;
        },
      ): Promise<void> =>
        events.recordDictationCompleted({
          ...completion,
          context: completion.context ?? events.captureDictationContext(),
        }),
    },
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
    getItem: jest.fn(async (key: string) => items.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
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

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
    r.server.linkedAccounts.set(ANONYMOUS.userId, ACCOUNT.cookie);
    await r.signInAs(ACCOUNT);

    const onboarding = r.sentEvents().find((event) => event.event_name === 'onboarding_completed');
    expect(onboarding).toMatchObject({ occurred_at: '2026-11-04T08:00:05.000Z', cookie: 'c-a1' });
    expect(r.queued()).toEqual([]);
  });

  it('keeps an anonymous completion queued until the API verifies its link to the uploader', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);
    r.server.offline = true;
    await r.events.recordOnboardingCompleted(COMPLETION);
    r.server.offline = false;

    await r.signInAs(ACCOUNT);

    const batches = r.batches().filter((call) => call.cookie === ACCOUNT.cookie);
    expect(
      batches.map((call) => ({
        source: call.body.anonymous_source_user_id,
        names: call.body.events?.map((event) => event.event_name),
      })),
    ).toEqual([
      { source: undefined, names: ['app_session_authenticated'] },
      { source: ANONYMOUS.userId, names: ['onboarding_completed'] },
    ]);
    expect(r.queued().map((event) => event.owner_user_id)).toEqual([ANONYMOUS.userId]);

    r.server.linkedAccounts.set(ANONYMOUS.userId, ACCOUNT.cookie);
    await r.events.flush();
    expect(r.queued()).toEqual([]);
  });

  it('a rejected origin cannot starve another origin or settle its queued events', async () => {
    const secondOrigin = { userId: 'anon-2', isAnonymous: true, cookie: 'c-anon-2' };
    const r = rig();
    for (const origin of [ANONYMOUS, secondOrigin]) {
      await r.signInAs(origin);
      r.server.offline = true;
      await r.events.recordOnboardingCompleted(COMPLETION);
      r.server.offline = false;
      await r.signInAs(ACCOUNT);
    }
    r.server.linkedAccounts.set(ANONYMOUS.userId, OTHER.cookie);
    r.server.linkedAccounts.set(secondOrigin.userId, ACCOUNT.cookie);
    r.calls.length = 0;

    await r.events.flush();
    await r.events.flush();

    expect(r.batches().map((call) => call.body.anonymous_source_user_id)).toEqual([
      ANONYMOUS.userId,
      secondOrigin.userId,
    ]);
    expect(r.queued().map((event) => event.owner_user_id)).toEqual([ANONYMOUS.userId]);
  });

  it('keeps both own and anonymous milestones when a legacy API rejects the guarded batches', async () => {
    const r = rig();
    await r.signInAs(ANONYMOUS);
    r.server.offline = true;
    await r.events.recordOnboardingCompleted(COMPLETION);
    r.server.offline = false;
    r.server.legacyBatch = true;
    await r.signInAs(ACCOUNT);

    expect(r.queued().map((event) => event.owner_user_id)).toEqual([
      ANONYMOUS.userId,
      ACCOUNT.userId,
    ]);
    expect(
      r
        .batches()
        .filter((call) => call.cookie === ACCOUNT.cookie)
        .map((call) => [call.body.expected_user_id, call.body.anonymous_source_user_id]),
    ).toEqual([
      [ACCOUNT.userId, undefined],
      [ACCOUNT.userId, ANONYMOUS.userId],
    ]);
    expect(r.timers).toHaveLength(1);

    r.server.legacyBatch = false;
    r.server.linkedAccounts.set(ANONYMOUS.userId, ACCOUNT.cookie);
    r.timers[0]();
    await r.events.flush();
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

  it('does not dispatch coverage after opting out while loading the queue', async () => {
    const r = rig();
    const reading = deferred();
    const read = deferred();
    r.storage.getItem.mockImplementationOnce(async () => {
      reading.release();
      await read.promise;
      return null;
    });
    r.setIdentityQuietly(ANONYMOUS);

    const flushing = r.events.flush();
    await reading.promise;
    const disabling = r.setUsageAnalytics(false);
    read.release();
    await Promise.all([flushing, disabling]);

    expect(r.calls).toEqual([]);
  });

  it('does not dispatch a bind after opting out while saving the installation ID', async () => {
    const r = rig();
    const writing = deferred();
    const write = deferred();
    r.storage.setItem.mockImplementationOnce(async () => undefined);
    r.storage.setItem.mockImplementationOnce(async () => {
      writing.release();
      await write.promise;
    });

    const observing = r.signInAs(ACCOUNT);
    await writing.promise;
    const disabling = r.setUsageAnalytics(false);
    write.release();
    await Promise.all([observing, disabling]);

    expect(r.calls).toEqual([]);
  });

  it('binds the held session again after an answer was discarded during opt-out', async () => {
    const r = rig();
    r.server.afterAnswer = () => r.setUsageAnalyticsQuietly(false);
    await r.signInAs(ACCOUNT);
    await r.setUsageAnalytics(false);
    expect(r.queued()).toEqual([]);

    r.server.afterAnswer = null;
    await r.setUsageAnalytics(true);

    expect(r.calls.filter((call) => call.path.endsWith('/app-session'))).toHaveLength(2);
    expect(r.sentEvents().map((event) => event.event_id)).toEqual([BINDING]);
  });

  it('purges an interrupted opt-out on launch before a later opt-in can replay its queue', async () => {
    const storage = memoryStorage();
    const first = rig(storage);
    await first.signInAs(ACCOUNT);
    first.server.offline = true;
    await first.events.recordOnboardingCompleted(COMPLETION);
    expect(first.queued()).toHaveLength(1);

    const relaunched = rig(storage, { allowed: false });
    await relaunched.events.observeConsent();
    expect(relaunched.calls).toEqual([]);
    expect(relaunched.queued()).toEqual([]);

    await relaunched.setUsageAnalytics(true);
    await relaunched.signInAs(ACCOUNT);
    expect(relaunched.sentEvents()).toEqual([]);
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

function overflowDictations(client: ReturnType<typeof rig>): Promise<void>[] {
  const previous = client.events.captureDictationContext();
  client.setIdentityQuietly({
    userId: 'overflow-account',
    cookie: 'c-overflow',
    isAnonymous: false,
  });
  client.setOnboarding(true);
  const context = client.events.captureDictationContext();
  client.setIdentityQuietly(previous.identity);
  client.setOnboarding(previous.isPractice);
  return Array.from(
    { length: 200 },
    (_, index): Promise<void> =>
      client.events.recordDictationCompleted({ ...dictation(10_000 + index, 1), context }),
  );
}

describe('mobile dictation', () => {
  it.each([null, OTHER])(
    'a cached capture identity keeps its owner while the validated session is %s',
    async (validatedIdentity): Promise<void> => {
      const client = rig();
      await client.signInAs(validatedIdentity);
      const context = client.events.captureDictationContext(ACCOUNT);
      await client.signInAs(OTHER);
      await client.events.recordDictationCompleted({ ...dictation(1, 200), context });
      expect(
        client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
      ).toEqual([]);
      expect(client.queued().map((event) => event.owner_user_id)).toEqual([ACCOUNT.userId]);

      await client.signInAs(ACCOUNT);
      expect(
        client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
      ).toEqual([expect.objectContaining({ cookie: ACCOUNT.cookie })]);
    },
  );

  it('an explicitly absent capture identity never adopts the validated account', async (): Promise<void> => {
    const client = rig();
    await client.signInAs(ACCOUNT);
    const context = client.events.captureDictationContext(null);
    await client.events.recordDictationCompleted({ ...dictation(1, 200), context });
    expect(
      client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toEqual([]);
    await client.events.recordDictationCompleted(dictation(2, 200));
    expect(
      client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toHaveLength(1);
  });

  it.each([50, null])(
    'a rejected %s-word acknowledgement releases only its pending contribution across relaunch',
    async (words): Promise<void> => {
      const storage = memoryStorage();
      const client = rig(storage);
      await client.signInAs(ACCOUNT);
      await client.events.recordDictationCompleted(dictation(1, 150));
      client.server.offline = true;
      await client.events.recordDictationCompleted(dictation(2, words));
      client.server.reject.add(client.queued()[0].event_id);
      client.server.offline = false;
      await client.events.flush();
      expect(client.queued()).toEqual([]);

      const relaunched = rig(storage);
      await relaunched.signInAs(ACCOUNT);
      await relaunched.events.recordDictationCompleted(dictation(3, words));
      await relaunched.events.recordDictationCompleted(dictation(4, words));
      expect(
        relaunched.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
      ).toEqual([
        expect.objectContaining({ properties: expect.objectContaining({ word_count: words }) }),
      ]);
    },
  );

  it('a mixed acknowledgement retains stored and duplicate words while releasing rejected words', async (): Promise<void> => {
    const storage = memoryStorage();
    const client = rig(storage);
    await client.signInAs(ACCOUNT);
    await client.events.recordDictationCompleted(dictation(1, 100));
    client.server.offline = true;
    await client.events.recordDictationCompleted(dictation(2, 25));
    await client.events.recordDictationCompleted(dictation(3, 25));
    await client.events.recordDictationCompleted(dictation(4, 50));
    client.server.duplicate.add(client.queued()[1].event_id);
    client.server.reject.add(client.queued()[2].event_id);
    client.server.offline = false;
    await client.events.flush();
    expect(client.queued()).toEqual([]);

    const relaunched = rig(storage);
    await relaunched.signInAs(ACCOUNT);
    await relaunched.events.recordDictationCompleted(dictation(5, 49));
    await relaunched.events.recordDictationCompleted(dictation(6, 1));
    await relaunched.events.recordDictationCompleted(dictation(7, 1));
    expect(
      relaunched
        .sentEvents()
        .filter((event) => event.event_name === 'dictation_completed')
        .map((event) => (event.properties as { word_count: number }).word_count),
    ).toEqual([49, 1]);
  });

  it.each([
    { words: 50, discard: 'consent' },
    { words: null, discard: 'consent' },
    { words: 50, discard: 'eviction' },
    { words: null, discard: 'eviction' },
  ])(
    'a late rejected $words-word acknowledgement cannot restore a contribution removed by $discard',
    async ({ words, discard }): Promise<void> => {
      const storage = memoryStorage();
      const client = rig(storage);
      await client.signInAs(ACCOUNT);
      await client.events.recordDictationCompleted(dictation(1, 150));
      const upload = deferred();
      client.server.hold = upload.promise;
      const recording = client.events.recordDictationCompleted(dictation(2, words));
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 0);
      });
      expect(client.server.hold).toBeNull();
      client.server.reject.add(client.queued()[0].event_id);
      let overflow: Promise<void>[] = [];
      if (discard === 'consent') await client.setUsageAnalytics(false);
      else {
        overflow = overflowDictations(client);
        await new Promise<void>((resolve): void => {
          setTimeout(resolve, 0);
        });
      }
      expect(queuedDictation(client).filter(([, practice]) => !practice)).toEqual([]);
      client.setIdentityQuietly(OTHER);
      upload.release();
      await Promise.all([recording, ...overflow]);
      await client.events.flush();

      const relaunched = rig(storage);
      await relaunched.signInAs(ACCOUNT);
      await relaunched.events.recordDictationCompleted(dictation(3, words));
      await relaunched.events.recordDictationCompleted(dictation(4, words));
      expect(
        relaunched.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
      ).toEqual([
        expect.objectContaining({ properties: expect.objectContaining({ word_count: words }) }),
      ]);
    },
  );

  it.each([
    { blocked: { ...ACCOUNT, cookie: 'c-a2' }, afterBlock: null, keepsCapture: false },
    { blocked: OTHER, afterBlock: null, keepsCapture: true },
    { blocked: { ...ACCOUNT, cookie: 'c-a2' }, afterBlock: OTHER, keepsCapture: false },
  ])(
    'applies a newly blocked session only to captures of its account (keepsCapture=$keepsCapture)',
    async ({ blocked, afterBlock, keepsCapture }): Promise<void> => {
      const client = rig();
      await client.signInAs(ACCOUNT);
      const context = client.events.captureDictationContext();
      client.server.batchStatus = 403;
      client.server.batchCode = 'POLICY_CLOUD_BACKUP_BLOCKED';
      await client.signInAs(blocked);
      if (afterBlock) {
        client.server.batchStatus = 200;
        await client.signInAs(afterBlock);
      }
      await client.events.recordDictationCompleted({ ...dictation(1, 200), context });
      expect(client.queued().map((event) => event.owner_user_id)).toEqual(
        keepsCapture ? [ACCOUNT.userId] : [],
      );

      client.server.batchStatus = 200;
      await client.signInAs({ ...ACCOUNT, cookie: 'c-a3' });
      await client.events.recordDictationCompleted(dictation(2, 200));
      expect(
        client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
      ).toHaveLength(1);
    },
  );

  it('drops every queued fact for the policy-refused account beyond one batch', async (): Promise<void> => {
    const storage = memoryStorage();
    const client = rig(storage);
    await client.signInAs(ACCOUNT);
    await client.events.recordDictationCompleted(dictation(1, 100));
    client.server.offline = true;
    for (let index = 0; index < 100; index += 1) {
      await client.events.recordDictationCompleted(dictation(100 + index, 1));
    }
    await client.signInAs(OTHER);
    await client.events.recordDictationCompleted(dictation(2, 30));
    client.setIdentityQuietly(ACCOUNT);
    client.server.offline = false;
    client.server.batchStatus = 403;
    client.server.batchCode = 'POLICY_CLOUD_BACKUP_BLOCKED';
    await client.events.flush();
    expect(client.queued().map((event) => event.owner_user_id)).toEqual([OTHER.userId]);

    const relaunched = rig(storage);
    await relaunched.signInAs(ACCOUNT);
    await relaunched.events.recordDictationCompleted(dictation(3, 100));
    await relaunched.events.recordDictationCompleted(dictation(4, 1));
    await relaunched.signInAs(OTHER);
    await relaunched.events.recordDictationCompleted(dictation(5, 170));
    await relaunched.events.recordDictationCompleted(dictation(6, 1));
    expect(
      relaunched
        .sentEvents()
        .filter((event) => event.event_name === 'dictation_completed')
        .map((event) => [event.cookie, (event.properties as { word_count: number }).word_count]),
    ).toEqual([
      [ACCOUNT.cookie, 100],
      [OTHER.cookie, 30],
      [OTHER.cookie, 170],
    ]);
  });

  it('bounds milestone and dictation backlogs independently', async (): Promise<void> => {
    const client = rig();
    await client.signInAs(ACCOUNT);
    client.server.offline = true;
    client.setOnboarding(true);
    const context = {
      identity: ACCOUNT,
      isPractice: true,
      consentSignal: new AbortController().signal,
    };
    for (let index = 0; index < 201; index += 1) {
      await client.events.recordDictationCompleted({ ...dictation(index, 1), context });
      await client.events.recordOnboardingCompleted(COMPLETION);
    }
    expect(queuedDictation(client)).toHaveLength(200);
    expect(
      client.queued().filter((event) => event.event_name === 'onboarding_completed'),
    ).toHaveLength(200);
    expect(client.queued()).toHaveLength(400);
  });

  it('does not report a capture from before an opt-out and later opt-in', async (): Promise<void> => {
    const client = rig();
    await client.signInAs(ACCOUNT);
    const context = client.events.captureDictationContext();
    await client.setUsageAnalytics(false);
    await client.setUsageAnalytics(true);
    await client.events.recordDictationCompleted({ ...dictation(1, 200), context });
    expect(
      client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toEqual([]);
    await client.events.recordDictationCompleted(dictation(2, 200));
    expect(
      client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toHaveLength(1);
  });

  it('keeps practice classification from the capture start', async (): Promise<void> => {
    const client = rig();
    await client.signInAs(ACCOUNT);
    client.setOnboarding(true);
    const context = client.events.captureDictationContext();
    client.setOnboarding(false);
    await client.events.recordDictationCompleted({ ...dictation(1, 200), context });
    await client.events.recordDictationCompleted(dictation(2, 200));
    expect(
      client
        .sentEvents()
        .filter((event) => event.event_name === 'dictation_completed')
        .map((event) => event.properties),
    ).toEqual([
      expect.objectContaining({ is_practice: true }),
      expect.objectContaining({ is_practice: false }),
    ]);
  });

  it('keeps onboarding and session milestones alongside the first 200 one-word dictations', async (): Promise<void> => {
    const client = rig();
    client.server.batchStatus = 503;
    await client.signInAs(ACCOUNT);
    await client.events.recordOnboardingCompleted(COMPLETION);
    for (let index = 0; index < 200; index += 1) {
      await client.events.recordDictationCompleted(dictation(index, 1));
    }
    expect(
      client.queued().filter((event) => event.event_name !== 'dictation_completed'),
    ).toHaveLength(2);
    expect(queuedDictation(client)).toHaveLength(200);
    client.server.batchStatus = 200;
    client.calls.length = 0;
    await client.events.flush();
    expect(
      client.sentEvents().filter((event) => event.event_name === 'onboarding_completed'),
    ).toHaveLength(1);
    expect(
      client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toHaveLength(200);
  });

  it.each([null, ANONYMOUS])(
    'does not adopt a pre-signup dictation after authentication (%s)',
    async (identity): Promise<void> => {
      const client = rig();
      await client.signInAs(ACCOUNT);
      await client.events.recordDictationCompleted({
        ...dictation(1, 200),
        context: { identity, isPractice: false, consentSignal: new AbortController().signal },
      });
      expect(
        client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
      ).toEqual([]);
    },
  );

  it('keeps a completed capture on its original account through a session switch', async (): Promise<void> => {
    const client = rig();
    await client.signInAs(OTHER);
    await client.events.recordDictationCompleted({
      ...dictation(1, 200),
      context: {
        identity: ACCOUNT,
        isPractice: false,
        consentSignal: new AbortController().signal,
      },
    });
    expect(
      client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toEqual([]);
    expect(client.queued().map((event) => event.owner_user_id)).toEqual([ACCOUNT.userId]);
    await client.signInAs(ACCOUNT);
    expect(
      client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toEqual([expect.objectContaining({ cookie: ACCOUNT.cookie })]);
  });

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

  it('resumes dictation after consent discards an offline crossing, including after relaunch', async (): Promise<void> => {
    const storage = memoryStorage();
    const first = rig(storage);
    await first.signInAs(ACCOUNT);
    first.server.offline = true;
    await first.events.recordDictationCompleted(dictation(1, 200, { provider: 'local' }));
    expect(queuedDictation(first)).toEqual([[200, false, false]]);

    await first.setUsageAnalytics(false);
    expect(first.queued()).toEqual([]);
    const relaunched = rig(storage, { allowed: false });
    await relaunched.signInAs(ACCOUNT);
    await relaunched.setUsageAnalytics(true);
    await relaunched.events.recordDictationCompleted(dictation(2, 250));
    await relaunched.events.recordDictationCompleted(dictation(3, 1));

    expect(
      relaunched.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ word_count: 250 }) }),
    ]);
  });

  it('consent discards only unsent eligible words and preserves already uploaded progress', async (): Promise<void> => {
    const client = rig();
    await client.signInAs(ACCOUNT);
    await client.events.recordDictationCompleted(dictation(1, 150));
    client.server.offline = true;
    client.setOnboarding(true);
    await client.events.recordDictationCompleted(dictation(2, 180));
    client.setOnboarding(false);
    await client.events.recordDictationCompleted(dictation(3, 150, { retranscribe: true }));
    await client.events.recordDictationCompleted(dictation(4, 50));

    await client.setUsageAnalytics(false);
    client.server.offline = false;
    await client.setUsageAnalytics(true);
    await client.events.recordDictationCompleted(dictation(5, 49));
    await client.events.recordDictationCompleted(dictation(6, 1));
    await client.events.recordDictationCompleted(dictation(7, 20));

    expect(
      client
        .sentEvents()
        .filter((event) => event.event_name === 'dictation_completed')
        .map((event) => (event.properties as { word_count: number }).word_count),
    ).toEqual([150, 49, 1]);
  });

  it('consent allows a new uncountable fact after discarding the queued one', async (): Promise<void> => {
    const client = rig();
    await client.signInAs(ACCOUNT);
    client.server.offline = true;
    await client.events.recordDictationCompleted(dictation(1, null));
    await client.setUsageAnalytics(false);
    client.server.offline = false;
    await client.setUsageAnalytics(true);
    await client.events.recordDictationCompleted(dictation(2, null));
    await client.events.recordDictationCompleted(dictation(3, null));

    expect(
      client.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ word_count: null }) }),
    ]);
  });

  it.each([
    { words: 50, accepted: true, switchAccount: false, revokeAfterAck: false },
    { words: null, accepted: true, switchAccount: false, revokeAfterAck: false },
    { words: 50, accepted: true, switchAccount: true, revokeAfterAck: false },
    { words: null, accepted: true, switchAccount: true, revokeAfterAck: false },
    { words: 50, accepted: true, switchAccount: true, revokeAfterAck: true },
    { words: null, accepted: true, switchAccount: true, revokeAfterAck: true },
    { words: 50, accepted: false, switchAccount: false, revokeAfterAck: false },
    { words: null, accepted: false, switchAccount: false, revokeAfterAck: false },
  ])(
    'settles an in-flight $words-word fact across consent changes (accepted=$accepted, switchAccount=$switchAccount, revokeAfterAck=$revokeAfterAck)',
    async ({ words, accepted, switchAccount, revokeAfterAck }): Promise<void> => {
      const storage = memoryStorage();
      const client = rig(storage);
      await client.signInAs(ACCOUNT);
      await client.events.recordDictationCompleted(dictation(1, 150));
      let release!: () => void;
      client.server.hold = new Promise<void>((resolve): void => {
        release = resolve;
      });
      const recording = client.events.recordDictationCompleted(dictation(2, words));
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 0);
      });
      expect(client.server.hold).toBeNull();

      if (!revokeAfterAck) await client.setUsageAnalytics(false);
      if (switchAccount) client.setIdentityQuietly(OTHER);
      client.server.offline = !accepted;
      release();
      await recording;
      if (revokeAfterAck) await client.setUsageAnalytics(false);
      expect(client.queued()).toEqual([]);

      const relaunched = rig(storage, { allowed: false });
      await relaunched.signInAs(ACCOUNT);
      await relaunched.setUsageAnalytics(true);
      await relaunched.events.recordDictationCompleted(dictation(3, words));
      await relaunched.events.recordDictationCompleted(dictation(4, words));
      expect(
        relaunched.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
      ).toHaveLength(accepted ? 0 : 1);
    },
  );

  it('settles consent and acknowledgement atomically when another storage write is pending', async (): Promise<void> => {
    const storage = memoryStorage();
    const client = rig(storage);
    await client.signInAs(ACCOUNT);
    await client.events.recordDictationCompleted(dictation(1, 150));
    let releaseUpload!: () => void;
    client.server.hold = new Promise<void>((resolve): void => {
      releaseUpload = resolve;
    });
    const recording = client.events.recordDictationCompleted(dictation(2, 50));
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    expect(client.server.hold).toBeNull();

    let releaseStorage!: () => void;
    const storageHeld = new Promise<void>((resolve): void => {
      releaseStorage = resolve;
    });
    const setItem = storage.setItem.getMockImplementation()!;
    storage.setItem.mockClear();
    jest.spyOn(storage, 'setItem').mockImplementationOnce(async (key, value): Promise<void> => {
      await storageHeld;
      await setItem(key, value);
    });
    const onboarding = client.events.recordOnboardingCompleted(COMPLETION);
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const consent = client.setUsageAnalytics(false);
    releaseUpload();
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    releaseStorage();
    await Promise.all([recording, onboarding, consent]);

    const relaunched = rig(storage, { allowed: false });
    await relaunched.signInAs(ACCOUNT);
    await relaunched.setUsageAnalytics(true);
    await relaunched.events.recordDictationCompleted(dictation(3, 50));
    expect(
      relaunched.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toEqual([]);
  });

  it.each([
    { discard: 'policy', words: 50 },
    { discard: 'policy', words: null },
    { discard: 'expiry', words: 50 },
    { discard: 'expiry', words: null },
    { discard: 'eviction', words: 50 },
    { discard: 'eviction', words: null },
  ])(
    '$discard releases pending $words-word dictation while preserving acknowledged progress',
    async ({ discard, words }): Promise<void> => {
      const storage = memoryStorage();
      const client = rig(storage);
      await client.signInAs(OTHER);
      await client.events.recordDictationCompleted(dictation(1, 200));
      await client.signInAs(ACCOUNT);
      await client.events.recordDictationCompleted(dictation(2, 150));
      client.server.offline = true;
      await client.events.recordDictationCompleted(dictation(3, words));

      if (discard === 'policy') {
        client.server.offline = false;
        client.server.batchStatus = 403;
        client.server.batchCode = 'POLICY_CLOUD_BACKUP_BLOCKED';
        await client.events.flush();
      } else if (discard === 'expiry') {
        client.advance(31 * 24 * 60 * 60_000);
        await client.events.flush();
      } else {
        await Promise.all(overflowDictations(client));
      }
      expect(queuedDictation(client).filter(([, practice]) => !practice)).toEqual([]);

      const relaunched = rig(storage);
      await relaunched.signInAs(ACCOUNT);
      await relaunched.events.recordDictationCompleted(dictation(4, words));
      await relaunched.events.recordDictationCompleted(dictation(5, words));
      await relaunched.signInAs(OTHER);
      await relaunched.events.recordDictationCompleted(dictation(6, 1));

      expect(
        relaunched.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
      ).toEqual([
        expect.objectContaining({
          cookie: ACCOUNT.cookie,
          properties: expect.objectContaining({ word_count: words }),
        }),
      ]);
    },
  );

  it.each([50, null])(
    'records the first %s-word dictation after the queued contribution expires',
    async (words): Promise<void> => {
      const client = rig();
      await client.signInAs(ACCOUNT);
      await client.events.recordDictationCompleted(dictation(1, 150));
      client.server.offline = true;
      await client.events.recordDictationCompleted(dictation(2, words));
      const expiredId = client.queued()[0].event_id;
      client.advance(31 * 24 * 60 * 60_000);
      await client.events.recordDictationCompleted(dictation(3, words));
      expect(queuedDictation(client)).toEqual([[words, false, false]]);
      expect(client.queued()[0].event_id).not.toBe(expiredId);

      client.server.offline = false;
      await client.events.flush();
      await client.events.recordDictationCompleted(dictation(4, words));
      expect(
        client
          .sentEvents()
          .filter((event) => event.event_name === 'dictation_completed')
          .map((event) => (event.properties as { word_count: number | null }).word_count),
      ).toEqual([150, words]);
    },
  );

  it('a policy refusal releases only the refused account pending words', async (): Promise<void> => {
    const storage = memoryStorage();
    const client = rig(storage);
    await client.signInAs(ACCOUNT);
    await client.events.recordDictationCompleted(dictation(1, 150));
    client.server.offline = true;
    await client.events.recordDictationCompleted(dictation(2, 50));
    await client.signInAs(OTHER);
    await client.events.recordDictationCompleted(dictation(3, 30));
    client.setIdentityQuietly(ACCOUNT);
    client.server.offline = false;
    client.server.batchStatus = 403;
    client.server.batchCode = 'POLICY_CLOUD_BACKUP_BLOCKED';
    await client.events.flush();
    expect(client.queued().map((event) => event.owner_user_id)).toEqual([OTHER.userId]);

    const relaunched = rig(storage);
    await relaunched.signInAs(ACCOUNT);
    await relaunched.events.recordDictationCompleted(dictation(4, 50));
    await relaunched.events.recordDictationCompleted(dictation(5, 1));
    await relaunched.signInAs(OTHER);
    await relaunched.events.recordDictationCompleted(dictation(6, 170));
    await relaunched.events.recordDictationCompleted(dictation(7, 1));
    expect(
      relaunched
        .sentEvents()
        .filter((event) => event.event_name === 'dictation_completed')
        .map((event) => [event.cookie, (event.properties as { word_count: number }).word_count]),
    ).toEqual([
      [ACCOUNT.cookie, 50],
      [OTHER.cookie, 30],
      [OTHER.cookie, 170],
    ]);
  });

  it.each([50, null])(
    'preserves an acknowledged %s-word fact after eviction during its upload',
    async (words): Promise<void> => {
      const storage = memoryStorage();
      const client = rig(storage);
      await client.signInAs(ACCOUNT);
      await client.events.recordDictationCompleted(dictation(1, 150));
      const upload = deferred();
      client.server.hold = upload.promise;
      const recording = client.events.recordDictationCompleted(dictation(2, words));
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 0);
      });
      expect(client.server.hold).toBeNull();
      const completions = overflowDictations(client);
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 0);
      });
      expect(queuedDictation(client).filter(([, practice]) => !practice)).toEqual([]);
      upload.release();
      await Promise.all([recording, ...completions]);
      await client.events.flush();

      const relaunched = rig(storage);
      await relaunched.signInAs(ACCOUNT);
      await relaunched.events.recordDictationCompleted(dictation(3, words));
      expect(
        relaunched.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
      ).toEqual([]);
    },
  );

  it('dropping a replacement uncountable fact preserves an evicted fact acknowledged late', async (): Promise<void> => {
    const storage = memoryStorage();
    const client = rig(storage);
    await client.signInAs(ACCOUNT);
    const upload = deferred();
    client.server.hold = upload.promise;
    const recording = client.events.recordDictationCompleted(dictation(1, null));
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    const completions = overflowDictations(client);
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    const replacement = client.events.recordDictationCompleted(dictation(2, null));
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0);
    });
    const queued = client
      .queued()
      .filter(
        (event) =>
          event.event_name === 'dictation_completed' && event.properties.is_practice === false,
      );
    expect(queued).toHaveLength(1);
    client.server.defer.add(queued[0].event_id);
    upload.release();
    await Promise.all([recording, replacement, ...completions]);
    await client.events.flush();
    await client.setUsageAnalytics(false);

    const relaunched = rig(storage, { allowed: false });
    await relaunched.signInAs(ACCOUNT);
    await relaunched.setUsageAnalytics(true);
    await relaunched.events.recordDictationCompleted(dictation(3, null));
    expect(
      relaunched.sentEvents().filter((event) => event.event_name === 'dictation_completed'),
    ).toEqual([]);
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

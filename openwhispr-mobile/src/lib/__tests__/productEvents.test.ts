import {
  PRODUCT_EVENT_CAPABILITIES,
  createProductEvents,
  type ProductEventsIdentity,
  type ProductEventsResponse,
} from '../productEvents';

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
        response = {
          status: 200,
          body: { accepted: ids.filter((id) => !server.defer.has(id)) },
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
          events: { event_id: string; owner_user_id: string }[];
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

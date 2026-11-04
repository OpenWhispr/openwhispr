import { randomUUID } from '@/lib/uuid';
import type { ProcessingMode } from '@/types';

// Dashboard funnel milestones (/api/product-events/batch). Content-free: never
// transcripts, audio, titles or provider details. Sent with every upload as
// coverage, which tells a stage nobody could observe apart from one that never
// happened.
export const PRODUCT_EVENT_CAPABILITIES = ['app_session_authenticated', 'onboarding_completed'];

const STORAGE_KEY = 'openwhispr_product_events';
const STATE_VERSION = 1;
const SCHEMA_VERSION = 1;
const BATCH_SIZE = 50;
// The queue only ever holds a handful of milestones; these bound what a server
// that never acknowledges (deferring an event forever, or unreachable) leaves behind.
const MAX_QUEUED_EVENTS = 200;
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
// Sign-ins the server already took. A relaunch restores the same session and
// gets the same binding back, which then needs no second upload.
const MAX_ACKNOWLEDGED_BINDINGS = 50;

// Mobile's processing modes in the vocabulary every client reports.
const SETUP_MODES: Record<ProcessingMode, 'cloud' | 'byok' | 'local'> = {
  cloud: 'cloud',
  private: 'local',
  providers: 'byok',
};

/** The session the auth store holds: its user and cookie always change together. */
export interface ProductEventsIdentity {
  userId: string;
  isAnonymous: boolean;
  cookie: string;
}

interface QueuedEvent {
  event_id: string;
  event_name: string;
  occurred_at: string;
  owner_user_id: string;
  owner_is_anonymous: boolean;
  identity_generation: number;
  app_version: string | null;
  flow_version: string | null;
  properties: Record<string, unknown>;
  captured_at: string;
}

interface State {
  version: number;
  installationId: string | null;
  /** Bumped on every change of session, so each event names the one it was captured under. */
  generation: number;
  events: QueuedEvent[];
  /**
   * Anonymous onboarding users and the account each signed straight into.
   * That sign-in is what the server links, so their queued events may upload
   * on the account's session; no other account ever sends them.
   */
  links: Record<string, string>;
  acknowledgedBindings: string[];
}

export interface ProductEventsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface ProductEventsResponse {
  status: number;
  body: unknown;
}

/** POSTs to the API with exactly this cookie, never whatever the store holds by then. */
export type ProductEventsRequest = (
  path: string,
  body: unknown,
  cookie: string,
) => Promise<ProductEventsResponse>;

interface Dependencies {
  storage: ProductEventsStorage;
  getIdentity: () => ProductEventsIdentity | null;
  /**
   * The Usage Analytics switch ("app-session analytics"). While it is off
   * nothing is recorded, bound, uploaded or reported, so the account reads as
   * unobserved.
   */
  isAllowed: () => boolean;
  request: ProductEventsRequest;
  os: string;
  appVersion: string | null;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
}

function emptyState(): State {
  return {
    version: STATE_VERSION,
    installationId: null,
    generation: 0,
    events: [],
    links: {},
    acknowledgedBindings: [],
  };
}

function identityKey(identity: ProductEventsIdentity | null): string | null {
  return identity ? `${identity.userId}\n${identity.cookie}` : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function createProductEvents({
  storage,
  getIdentity,
  isAllowed,
  request,
  os,
  appVersion,
  now = Date.now,
  setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
}: Dependencies) {
  let state: State | null = null;
  // Every read-modify-write runs here in turn, so two writers never race.
  let chain: Promise<unknown> = Promise.resolve();
  let running: Promise<void> | null = null;
  let flushAgain = false;
  let retryPending = false;
  let retryAttempt = 0;
  let lastIdentity: ProductEventsIdentity | null = null;
  let lastAllowed = isAllowed();
  // Per process run: the sessions bound and the sessions whose coverage was reported.
  const boundSessions = new Set<string>();
  const reportedSessions = new Set<string>();
  // Sessions whose organization keeps them unobserved.
  const blockedSessions = new Set<string>();

  function withState<T>(update: (current: State) => { next?: State; result: T }): Promise<T> {
    const run = chain.then(async () => {
      if (!state) {
        try {
          const raw = await storage.getItem(STORAGE_KEY);
          const parsed = raw ? (JSON.parse(raw) as State) : null;
          state =
            parsed?.version === STATE_VERSION && Array.isArray(parsed.events)
              ? { ...emptyState(), ...parsed }
              : emptyState();
        } catch {
          // An unreadable queue starts fresh: an unsent milestone reads as
          // unobserved, never as a wrong fact.
          state = emptyState();
        }
      }
      const { next, result } = update(state);
      if (next) {
        await storage.setItem(STORAGE_KEY, JSON.stringify(next));
        state = next;
      }
      return result;
    });
    chain = run.catch(() => undefined);
    return run;
  }

  function enqueue(event: Omit<QueuedEvent, 'identity_generation'>): Promise<void> {
    return withState((current) => {
      if (
        current.events.some((queued) => queued.event_id === event.event_id) ||
        current.acknowledgedBindings.includes(event.event_id.toLowerCase())
      ) {
        return { result: undefined };
      }
      const events = [...current.events, { ...event, identity_generation: current.generation }];
      return {
        // Oldest first out when full.
        next: { ...current, events: events.slice(-MAX_QUEUED_EVENTS) },
        result: undefined,
      };
    });
  }

  function installationId(): Promise<string> {
    return withState((current) => {
      if (current.installationId) return { result: current.installationId };
      const id = randomUUID();
      return { next: { ...current, installationId: id }, result: id };
    });
  }

  function stillCurrent(identity: ProductEventsIdentity): boolean {
    return identityKey(getIdentity()) === identityKey(identity);
  }

  function scheduleRetry(): void {
    if (retryPending) return;
    retryPending = true;
    const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
    retryAttempt += 1;
    setTimer(() => {
      retryPending = false;
      flush().catch(() => undefined);
    }, delay);
  }

  /**
   * The auth store moved to another session (or none). Called with every
   * change, including the restore at launch.
   */
  async function observeIdentity(): Promise<void> {
    const previous = lastIdentity;
    const next = getIdentity();
    if (identityKey(previous) === identityKey(next)) return;
    lastIdentity = next;
    await withState((current) => {
      const links =
        previous?.isAnonymous && next && !next.isAnonymous
          ? { ...current.links, [previous.userId]: next.userId }
          : current.links;
      return { next: { ...current, generation: current.generation + 1, links }, result: undefined };
    });
    if (next && !next.isAnonymous) await bindAppSession(next);
    else await flush();
  }

  /**
   * The Usage Analytics switch changed, or the saved config loaded. Turned off,
   * whatever is still queued is dropped. Turned on, the session held now is
   * observed from then on.
   */
  async function observeConsent(): Promise<void> {
    const allowed = isAllowed();
    if (allowed === lastAllowed) return;
    lastAllowed = allowed;
    if (!allowed) {
      await withState((current) => ({
        next: current.events.length > 0 ? { ...current, events: [] } : undefined,
        result: undefined,
      }));
      return;
    }
    const identity = getIdentity();
    if (identity && !identity.isAnonymous) await bindAppSession(identity);
    else await flush();
  }

  /**
   * App sign-in: a real account's session the store accepted (a sign-in, a
   * sign-up or a session restored at launch). The server records when it
   * first validated this session on this installation and the event is timed
   * by that, so a session that can't be validated (offline) records nothing.
   */
  async function bindAppSession(identity: ProductEventsIdentity): Promise<void> {
    // The binding itself is a server record, so it waits for the switch too.
    if (!isAllowed()) return;
    const key = identityKey(identity) as string;
    if (boundSessions.has(key)) return flush();
    boundSessions.add(key);
    let response: ProductEventsResponse | null = null;
    try {
      response = await request(
        '/api/product-events/app-session',
        {
          surface: 'mobile',
          os,
          installation_id: await installationId(),
          app_version: appVersion,
        },
        identity.cookie,
      );
    } catch {
      response = null;
    }
    const body = asRecord(response?.body);
    if (
      response?.status !== 200 ||
      typeof body.binding_id !== 'string' ||
      typeof body.authenticated_at !== 'string'
    ) {
      // Refused (policy, unbindable) or unanswered: unobserved, never a client
      // time. An outage may bind on the next change of session or relaunch.
      if (!response || response.status >= 500) boundSessions.delete(key);
      return flush();
    }
    if (!stillCurrent(identity) || !isAllowed()) return;
    await enqueue({
      // One binding is one event: relaunches resend the same id.
      event_id: body.binding_id,
      event_name: 'app_session_authenticated',
      occurred_at: body.authenticated_at,
      owner_user_id: identity.userId,
      owner_is_anonymous: false,
      app_version: appVersion,
      flow_version: null,
      properties: { binding_id: body.binding_id },
      captured_at: new Date(now()).toISOString(),
    });
    return flush();
  }

  /**
   * The final onboarding completion was persisted. Recorded under whoever
   * holds the session, an anonymous onboarding user included, and uploaded
   * while that session is still the one held. Without a session (a guest who
   * declined one) there is nobody to report it for.
   */
  async function recordOnboarding({
    mode,
    replay,
    flowVersion,
  }: {
    mode: ProcessingMode | null;
    replay: boolean;
    flowVersion: string;
  }): Promise<void> {
    const identity = getIdentity();
    if (!identity || !isAllowed()) return;
    const occurredAt = new Date(now()).toISOString();
    await enqueue({
      event_id: randomUUID(),
      event_name: 'onboarding_completed',
      occurred_at: occurredAt,
      owner_user_id: identity.userId,
      owner_is_anonymous: identity.isAnonymous,
      app_version: appVersion,
      flow_version: flowVersion,
      properties: mode ? { replay, setup_mode: SETUP_MODES[mode] } : { replay },
      captured_at: occurredAt,
    });
    await flush();
  }

  function flush(): Promise<void> {
    if (running) {
      // The running pass read the queue before whatever asked for this one.
      flushAgain = true;
      return running;
    }
    flushAgain = false;
    running = runPass()
      .catch(() => scheduleRetry())
      .finally(() => {
        running = null;
        if (flushAgain) flush().catch(() => undefined);
      });
    return running;
  }

  async function runPass(): Promise<void> {
    const identity = getIdentity();
    if (!identity || !isAllowed()) return;
    const key = identityKey(identity) as string;
    if (blockedSessions.has(key)) return;

    const pending = await withState((current) => {
      const cutoff = now() - MAX_EVENT_AGE_MS;
      const events = current.events.filter((event) => !(Date.parse(event.captured_at) < cutoff));
      // This session's own events, and those of an anonymous user that signed
      // straight into it. Another account's wait for that account.
      const ours = events
        .filter(
          (event) =>
            event.owner_user_id === identity.userId ||
            (event.owner_is_anonymous && current.links[event.owner_user_id] === identity.userId),
        )
        .slice(0, BATCH_SIZE);
      return {
        next: events.length === current.events.length ? undefined : { ...current, events },
        result: ours,
      };
    });
    if (pending.length === 0 && reportedSessions.has(key)) return;

    const response = await request(
      '/api/product-events/batch',
      {
        collector: {
          surface: 'mobile',
          os,
          installation_id: await installationId(),
          app_version: appVersion,
          capabilities: PRODUCT_EVENT_CAPABILITIES,
          sent_at: new Date(now()).toISOString(),
        },
        events: pending.map((event) => ({
          event_id: event.event_id,
          event_name: event.event_name,
          schema_version: SCHEMA_VERSION,
          occurred_at: event.occurred_at,
          app_version: event.app_version,
          flow_version: event.flow_version,
          identity_generation: event.identity_generation,
          properties: event.properties,
        })),
      },
      identity.cookie,
    );
    // The answer is for a session the store may no longer hold; the next
    // pass, under whichever session it holds now, settles the queue.
    if (!stillCurrent(identity)) return;

    const body = asRecord(response.body);
    if (response.status === 403 && String(body.code ?? '').startsWith('POLICY_')) {
      // The organization keeps this account unobserved; what it queued is not
      // collected later either.
      blockedSessions.add(key);
      const sent = new Set(pending.map((event) => event.event_id));
      await withState((current) => ({
        next: { ...current, events: current.events.filter((event) => !sent.has(event.event_id)) },
        result: undefined,
      }));
      return;
    }
    // A dead session waits for the next one.
    if (response.status === 401) return;
    // Includes 503 PRODUCT_EVENTS_RETRY, sent when an identity link completed mid-upload.
    if (response.status !== 200)
      throw new Error(`Product events upload failed: ${response.status}`);

    retryAttempt = 0;
    reportedSessions.add(key);
    // Only accepted ids leave the queue. Deferred ones (an older API that
    // doesn't know the event yet) and any id the answer leaves out stay,
    // until accepted or too old, and go again with the next upload.
    const accepted = new Set(
      (Array.isArray(body.accepted) ? body.accepted : []).map((id) => String(id).toLowerCase()),
    );
    if (accepted.size > 0) {
      const bindings = pending
        .filter(
          (event) =>
            event.event_name === 'app_session_authenticated' &&
            accepted.has(event.event_id.toLowerCase()),
        )
        .map((event) => event.event_id.toLowerCase());
      await withState((current) => ({
        next: {
          ...current,
          acknowledgedBindings: [...current.acknowledgedBindings, ...bindings].slice(
            -MAX_ACKNOWLEDGED_BINDINGS,
          ),
          events: current.events.filter((event) => !accepted.has(event.event_id.toLowerCase())),
        },
        result: undefined,
      }));
    }
    if (pending.length === BATCH_SIZE && accepted.size === pending.length) await runPass();
  }

  return {
    observeIdentity,
    observeConsent,
    recordOnboardingCompleted: recordOnboarding,
    flush,
    installationId,
  };
}

export type ProductEvents = ReturnType<typeof createProductEvents>;

let runtime: ProductEvents | null = null;

/** Wires the queue to the auth store and the API. Called once from the root layout. */
export function initProductEvents(): void {
  if (runtime) return;
  const AsyncStorage = (
    require('@react-native-async-storage/async-storage') as typeof import('@react-native-async-storage/async-storage')
  ).default;
  const { Platform } = require('react-native') as typeof import('react-native');
  const Constants = (require('expo-constants') as typeof import('expo-constants')).default;
  const { fetch } = require('expo/fetch') as typeof import('expo/fetch');
  const { BASE_URL, getClientVersionHeader } =
    require('@/lib/apiClient') as typeof import('@/lib/apiClient');
  const { useAuthStore } = require('@/store/useAuthStore') as typeof import('@/store/useAuthStore');
  const { useConfigStore } =
    require('@/store/useConfigStore') as typeof import('@/store/useConfigStore');
  const { isUsageAnalyticsAllowed } =
    require('@/lib/usageAnalytics') as typeof import('@/lib/usageAnalytics');

  const instance = createProductEvents({
    storage: AsyncStorage,
    getIdentity: () => {
      const { user, sessionCookie, isGuest } = useAuthStore.getState();
      return user && sessionCookie && !isGuest
        ? { userId: user.id, isAnonymous: user.isAnonymous, cookie: sessionCookie }
        : null;
    },
    isAllowed: () => isUsageAnalyticsAllowed(useConfigStore.getState().config),
    request: async (path, body, cookie) => {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getClientVersionHeader(),
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    os: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'unknown',
    appVersion: Constants.expoConfig?.version ?? null,
  });
  runtime = instance;
  // An unreadable store costs this pass only; the next change of session retries.
  const observe = () => {
    instance.observeIdentity().catch(() => undefined);
  };
  useAuthStore.subscribe(observe);
  useConfigStore.subscribe(() => {
    instance.observeConsent().catch(() => undefined);
  });
  observe();
}

/** onboarding_completed, from useOnboardingStore.finish() once completion is persisted. */
export function recordOnboardingCompleted(completion: {
  mode: ProcessingMode | null;
  replay: boolean;
  flowVersion: string;
}): void {
  runtime?.recordOnboardingCompleted(completion).catch(() => undefined);
}

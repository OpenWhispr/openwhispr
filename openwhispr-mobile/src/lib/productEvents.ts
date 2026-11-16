import { randomUUID, uuidFromKey } from '@/lib/uuid';
import { WORD_COUNTER_VERSION } from '@/lib/wordCount';
import type { ProcessingMode, TranscriptionProvider } from '@/types';

// Dashboard funnel milestones (/api/product-events/batch). Content-free: never
// transcripts, audio, titles or provider details. Sent with every upload as
// coverage, which tells a stage nobody could observe apart from one that never
// happened.
export const PRODUCT_EVENT_CAPABILITIES = [
  'app_session_authenticated',
  'onboarding_completed',
  'dictation_completed',
];

const STORAGE_KEY = 'openwhispr_product_events';
const STATE_VERSION = 1;
const SCHEMA_VERSION = 1;
const BATCH_SIZE = 50;
// The queue only ever holds a handful of milestones and the dictations of the
// first 200 words; these bound what a server that never acknowledges
// (deferring an event forever, or unreachable) leaves behind.
// Milestones retain their original capacity independently of dictation traffic.
const MAX_QUEUED_EVENTS_PER_KIND = 200;
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
// The transcription that ran, in the analytics ledger's modes.
const DICTATION_MODES: Record<TranscriptionProvider, 'openwhispr_cloud' | 'local' | 'byok'> = {
  cloud: 'openwhispr_cloud',
  local: 'local',
  byok: 'byok',
};
// The funnel's last stage. Once this installation has recorded this many
// counted words for an account, none of its later dictations can be the one
// that crosses, for the account or for this platform, so none is recorded.
const DICTATION_WORDS_NEEDED = 200;

/** The session the auth store holds: its user and cookie always change together. */
export interface ProductEventsIdentity {
  userId: string;
  isAnonymous: boolean;
  cookie: string;
}

/** Capture-time session and consent scope; never persisted with the event. */
export interface ProductEventsCaptureContext {
  readonly identity: ProductEventsIdentity | null;
  readonly isPractice: boolean;
  readonly consentSignal: AbortSignal | null;
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
   * Candidate destinations for queued anonymous onboarding. The API must
   * verify the completed link before it can adopt an event.
   */
  links: Record<string, string>;
  acknowledgedBindings: string[];
  /** Counted dictation words recorded here, per account. */
  dictationWords: Record<string, number>;
  /**
   * One entry per uncountable contribution, queued or acknowledged. Usually
   * one per account; a late acknowledgement can overlap its replacement.
   */
  uncountedDictations: string[];
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
  signal: AbortSignal,
) => Promise<ProductEventsResponse>;

interface Dependencies {
  storage: ProductEventsStorage;
  getIdentity: () => ProductEventsIdentity | null;
  /**
   * The Usage Analytics switch, or null while its saved value is unknown.
   */
  getConsent: () => boolean | null;
  /** Onboarding is running or hasn't loaded: a dictation now is its practice. */
  isOnboarding: () => boolean;
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
    dictationWords: {},
    uncountedDictations: [],
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
  getConsent,
  isOnboarding,
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
  // Queue discards can race with the server acknowledging an in-flight fact.
  const discardedDictations = new Set<string>();
  let flushAgain = false;
  let retryPending = false;
  let retryAttempt = 0;
  let lastIdentity: ProductEventsIdentity | null = null;
  let lastConsent: boolean | null | undefined;
  let consent = new AbortController();
  let purgeNeeded = false;
  let purging: Promise<void> | null = null;
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

  function discardQueuedEvents(
    current: State,
    shouldDiscard: (event: QueuedEvent, index: number) => boolean,
  ): State {
    const discarded = current.events.filter(shouldDiscard);
    if (discarded.length === 0) return current;
    const discardedIds = new Set(discarded.map((event) => event.event_id));
    const dictationWords = { ...current.dictationWords };
    const uncountedDictations = [...current.uncountedDictations];
    for (const event of discarded) {
      if (
        event.event_name !== 'dictation_completed' ||
        event.properties.is_practice !== false ||
        event.properties.is_retranscribe !== false
      ) {
        continue;
      }
      if (running) discardedDictations.add(event.event_id);
      const words = event.properties.word_count;
      if (words === null) {
        const contribution = uncountedDictations.indexOf(event.owner_user_id);
        if (contribution !== -1) uncountedDictations.splice(contribution, 1);
      } else if (typeof words === 'number') {
        dictationWords[event.owner_user_id] = Math.max(
          0,
          (dictationWords[event.owner_user_id] ?? 0) - words,
        );
      }
    }
    return {
      ...current,
      events: current.events.filter((event) => !discardedIds.has(event.event_id)),
      dictationWords,
      uncountedDictations,
    };
  }

  /**
   * Queues an event once. `admit` decides, in the same write, whether it is
   * still wanted and what else changes with it; null leaves it unqueued.
   */
  function enqueue(
    event: Omit<QueuedEvent, 'identity_generation'>,
    mayRecord: () => boolean,
    admit: (current: State) => Partial<State> | null = () => ({}),
  ): Promise<boolean> {
    return withState((current) => {
      if (!mayRecord()) return { result: false };
      const cutoff = now() - MAX_EVENT_AGE_MS;
      const fresh = discardQueuedEvents(
        current,
        (queued) => Date.parse(queued.captured_at) < cutoff,
      );
      const trimmed = fresh !== current ? fresh : undefined;
      if (
        fresh.events.some((queued) => queued.event_id === event.event_id) ||
        fresh.acknowledgedBindings.includes(event.event_id.toLowerCase())
      ) {
        return { next: trimmed, result: true };
      }
      const changes = admit(fresh);
      if (!changes) return { next: trimmed, result: false };
      const events = [...fresh.events, { ...event, identity_generation: fresh.generation }];
      const isDictation = event.event_name === 'dictation_completed';
      const sameKind = events.filter(
        (queued) => (queued.event_name === 'dictation_completed') === isDictation,
      );
      const overflow = new Set(
        sameKind
          .slice(0, Math.max(0, sameKind.length - MAX_QUEUED_EVENTS_PER_KIND))
          .map((queued) => queued.event_id),
      );
      return {
        next: discardQueuedEvents({ ...fresh, ...changes, events }, (queued) =>
          overflow.has(queued.event_id),
        ),
        result: true,
      };
    });
  }

  function installationId(mayInstall: () => boolean = () => true): Promise<string | null> {
    return withState((current) => {
      if (!mayInstall()) return { result: null };
      if (current.installationId) return { result: current.installationId };
      const id = randomUUID();
      return { next: { ...current, installationId: id }, result: id };
    });
  }

  function stillCurrent(identity: ProductEventsIdentity): boolean {
    return identityKey(getIdentity()) === identityKey(identity);
  }

  function mayCollect(signal: AbortSignal): boolean {
    return !signal.aborted && !purgeNeeded && getConsent() === true;
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
    const signal = consent.signal;
    await withState((current) => {
      const links =
        mayCollect(signal) && previous?.isAnonymous && next && !next.isAnonymous
          ? { ...current.links, [previous.userId]: next.userId }
          : current.links;
      return { next: { ...current, generation: current.generation + 1, links }, result: undefined };
    });
    if (!mayCollect(signal) || identityKey(next) !== identityKey(getIdentity())) return;
    if (next && !next.isAnonymous) await bindAppSession(next);
    else await flush();
  }

  /**
   * The Usage Analytics switch changed, or the saved config loaded. Turned off,
   * whatever is still queued is dropped. Turned on, the session held now is
   * observed from then on.
   */
  async function observeConsent(): Promise<void> {
    const allowed = getConsent();
    if (allowed !== lastConsent) {
      lastConsent = allowed;
      consent.abort();
      consent = new AbortController();
      boundSessions.clear();
      reportedSessions.clear();
      if (allowed === false) purgeNeeded = true;
    } else if (!purgeNeeded) {
      return;
    }
    const signal = consent.signal;
    if (purgeNeeded) {
      purging ??= withState((current) => ({
        next: { ...discardQueuedEvents(current, () => true), links: {} },
        result: undefined,
      }))
        .then(() => {
          purgeNeeded = false;
        })
        .finally(() => {
          purging = null;
        });
      await purging;
    }
    if (!mayCollect(signal)) return;
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
    const signal = consent.signal;
    const active = (): boolean => mayCollect(signal) && stillCurrent(identity);
    if (!active()) return;
    const key = identityKey(identity) as string;
    if (boundSessions.has(key)) return flush();
    boundSessions.add(key);
    let keepBound = false;
    try {
      let response: ProductEventsResponse | null = null;
      try {
        const installation = await installationId(active);
        if (!installation || !active()) return;
        response = await request(
          '/api/product-events/app-session',
          {
            surface: 'mobile',
            os,
            installation_id: installation,
            app_version: appVersion,
          },
          identity.cookie,
          signal,
        );
      } catch {
        // A transport failure may bind on the next session change or relaunch.
      }
      if (!active()) return;
      const body = asRecord(response?.body);
      if (
        response?.status === 200 &&
        typeof body.binding_id === 'string' &&
        typeof body.authenticated_at === 'string'
      ) {
        keepBound = await enqueue(
          {
            event_id: body.binding_id,
            event_name: 'app_session_authenticated',
            occurred_at: body.authenticated_at,
            owner_user_id: identity.userId,
            owner_is_anonymous: false,
            app_version: appVersion,
            flow_version: null,
            properties: { binding_id: body.binding_id },
            captured_at: new Date(now()).toISOString(),
          },
          active,
        );
      } else {
        keepBound = response !== null && response.status < 500;
      }
      return flush();
    } finally {
      // A newer consent epoch can already be binding this same session.
      if (!keepBound && !signal.aborted) boundSessions.delete(key);
    }
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
    const signal = consent.signal;
    const active = (): boolean => mayCollect(signal);
    if (!identity || !active()) return;
    const occurredAt = new Date(now()).toISOString();
    const queued = await enqueue(
      {
        event_id: randomUUID(),
        event_name: 'onboarding_completed',
        occurred_at: occurredAt,
        owner_user_id: identity.userId,
        owner_is_anonymous: identity.isAnonymous,
        app_version: appVersion,
        flow_version: flowVersion,
        properties: mode ? { replay, setup_mode: SETUP_MODES[mode] } : { replay },
        captured_at: occurredAt,
      },
      active,
    );
    if (queued && active()) await flush();
  }

  // Startup can restore a capture owner before validation; uploads still use getIdentity.
  function captureContext(
    identity: ProductEventsIdentity | null = getIdentity(),
  ): ProductEventsCaptureContext {
    const signal = consent.signal;
    const allowed =
      mayCollect(signal) &&
      identity !== null &&
      !blockedSessions.has(identityKey(identity) as string);
    return {
      identity: allowed ? { ...identity } : null,
      isPractice: isOnboarding(),
      consentSignal: allowed ? signal : null,
    };
  }

  /**
   * An original dictation finished: its word count, never its words. Only an
   * account records one; words spoken before sign-up never count.
   * `retranscribe` is a recording transcribed again after its first attempt
   * failed, recorded as such and never counted.
   */
  async function recordDictation({
    context,
    captureId,
    words,
    provider,
    source,
    retranscribe,
  }: {
    context: ProductEventsCaptureContext;
    captureId: string;
    words: number | null;
    provider: TranscriptionProvider;
    source: 'dictation' | 'keyboard';
    retranscribe: boolean;
  }): Promise<void> {
    const { identity, consentSignal: signal, isPractice: practice } = context;
    if (!identity || identity.isAnonymous || signal === null || words === 0) return;
    const active = (): boolean => {
      const currentIdentity = getIdentity();
      const accountBlocked =
        currentIdentity?.userId === identity.userId
          ? blockedSessions.has(identityKey(currentIdentity) as string)
          : [...blockedSessions].some((key) => key.startsWith(`${identity.userId}\n`));
      return (
        mayCollect(signal) &&
        !blockedSessions.has(identityKey(identity) as string) &&
        !accountBlocked
      );
    };
    // A refreshed session can learn the original account's policy while capture is in flight.
    if (!active()) return;
    const counts = !practice && !retranscribe;
    const occurredAt = new Date(now()).toISOString();
    const queued = await enqueue(
      {
        // One recording is one event, however often a path reports it.
        event_id: await uuidFromKey(`dictation_completed:${captureId}`),
        event_name: 'dictation_completed',
        occurred_at: occurredAt,
        owner_user_id: identity.userId,
        owner_is_anonymous: false,
        app_version: appVersion,
        flow_version: null,
        properties: {
          word_count: words,
          counter_version: WORD_COUNTER_VERSION,
          mode: DICTATION_MODES[provider],
          source,
          is_practice: practice,
          is_retranscribe: retranscribe,
        },
        captured_at: occurredAt,
      },
      active,
      (current) => {
        const counted = current.dictationWords[identity.userId] ?? 0;
        if (
          counted >= DICTATION_WORDS_NEEDED ||
          (counts && words === null && current.uncountedDictations.includes(identity.userId))
        ) {
          return null;
        }
        if (!counts) return {};
        return words === null
          ? { uncountedDictations: [...current.uncountedDictations, identity.userId] }
          : { dictationWords: { ...current.dictationWords, [identity.userId]: counted + words } };
      },
    );
    if (queued && active()) await flush();
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
        discardedDictations.clear();
        running = null;
        if (flushAgain) flush().catch(() => undefined);
      });
    return running;
  }

  async function runPass(): Promise<void> {
    const identity = getIdentity();
    const signal = consent.signal;
    if (!identity || !mayCollect(signal)) return;
    const active = (): boolean => mayCollect(signal) && stillCurrent(identity);
    const key = identityKey(identity) as string;
    if (blockedSessions.has(key)) return;

    const batches = await withState((current) => {
      const cutoff = now() - MAX_EVENT_AGE_MS;
      const fresh = active()
        ? discardQueuedEvents(current, (event) => Date.parse(event.captured_at) < cutoff)
        : current;
      const { events } = fresh;
      // Own events go first. Each candidate anonymous origin needs a separate
      // request so the API can verify its link without blocking other origins.
      const groups = new Map<string | null, QueuedEvent[]>([[null, []]]);
      for (const event of events) {
        const ownEvent = event.owner_user_id === identity.userId;
        const candidateLink =
          !identity.isAnonymous &&
          event.owner_is_anonymous &&
          current.links[event.owner_user_id] === identity.userId;
        if (!ownEvent && !candidateLink) continue;
        const origin = ownEvent ? null : event.owner_user_id;
        const group = groups.get(origin) ?? [];
        if (group.length < BATCH_SIZE) group.push(event);
        groups.set(origin, group);
      }
      return {
        next: fresh !== current ? fresh : undefined,
        result: [...groups].filter(
          ([, pending]) => pending.length > 0 || !reportedSessions.has(key),
        ),
      };
    });
    if (!active() || batches.length === 0) return;
    const installation = await installationId(active);
    if (!installation) return;
    let retry = false;
    let more = false;

    for (const [origin, pending] of batches) {
      if (!active()) return;
      const response = await request(
        '/api/product-events/batch',
        {
          expected_user_id: identity.userId,
          ...(origin ? { anonymous_source_user_id: origin } : {}),
          collector: {
            surface: 'mobile',
            os,
            installation_id: installation,
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
        signal,
      ).catch(() => null);
      const body = asRecord(response?.body);
      const accepted = new Set(
        (Array.isArray(body.accepted) ? body.accepted : []).map((id) => String(id).toLowerCase()),
      );
      if (response?.status === 200 && accepted.size > 0) {
        // Accepted means stop retrying, including rejected facts that cannot count.
        const rejected = new Set(
          (Array.isArray(body.rejected) ? body.rejected : []).map((outcome) =>
            String(asRecord(outcome).event_id ?? '').toLowerCase(),
          ),
        );
        const bindings = pending
          .filter(
            (event) =>
              event.event_name === 'app_session_authenticated' &&
              accepted.has(event.event_id.toLowerCase()),
          )
          .map((event) => event.event_id.toLowerCase());
        const acceptedDictationIds = new Set(
          pending
            .filter(
              (event) =>
                event.event_name === 'dictation_completed' &&
                accepted.has(event.event_id.toLowerCase()),
            )
            .map((event) => event.event_id.toLowerCase()),
        );
        // Settle acknowledgements and discarded contributions in the same write,
        // so a queue discard cannot lose progress between those operations.
        await withState((current) => {
          const currentSession = active();
          if (!currentSession && acceptedDictationIds.size === 0) return { result: undefined };
          const retained = discardQueuedEvents(current, (event) => {
            const id = event.event_id.toLowerCase();
            return acceptedDictationIds.has(id) && rejected.has(id);
          });
          const queuedIds = new Set(retained.events.map((event) => event.event_id));
          const dictationWords = { ...retained.dictationWords };
          const uncountedDictations = [...retained.uncountedDictations];
          for (const event of pending) {
            if (
              !discardedDictations.has(event.event_id) ||
              !accepted.has(event.event_id.toLowerCase()) ||
              rejected.has(event.event_id.toLowerCase()) ||
              queuedIds.has(event.event_id)
            ) {
              continue;
            }
            const words = event.properties.word_count;
            if (words === null) uncountedDictations.push(event.owner_user_id);
            else if (typeof words === 'number')
              dictationWords[event.owner_user_id] =
                (dictationWords[event.owner_user_id] ?? 0) + words;
          }
          return {
            next: {
              ...retained,
              dictationWords,
              uncountedDictations,
              acknowledgedBindings: currentSession
                ? [...retained.acknowledgedBindings, ...bindings].slice(-MAX_ACKNOWLEDGED_BINDINGS)
                : retained.acknowledgedBindings,
              // Accepted dictations settle for their original owner even if the
              // session changed, so a later consent change cannot undo that progress.
              events: retained.events.filter((event): boolean => {
                const id = event.event_id.toLowerCase();
                return !acceptedDictationIds.has(id) && (!currentSession || !accepted.has(id));
              }),
            },
            result: undefined,
          };
        });
        for (const event of pending) discardedDictations.delete(event.event_id);
      }
      if (!active()) return;
      if (response?.status === 403 && String(body.code ?? '').startsWith('POLICY_')) {
        blockedSessions.add(key);
        await withState((current) => ({
          next: active()
            ? discardQueuedEvents(
                current,
                (event) =>
                  event.owner_user_id === identity.userId || event.owner_user_id === origin,
              )
            : undefined,
          result: undefined,
        }));
        return;
      }
      if (response?.status === 409 && origin && body.code === 'PRODUCT_EVENTS_LINK_MISMATCH') {
        await withState((current) => {
          if (!active() || current.links[origin] !== identity.userId) return { result: undefined };
          // Preserve the original owner's queue. Retire only this routing hint.
          const links = { ...current.links };
          delete links[origin];
          return { next: { ...current, links }, result: undefined };
        });
        continue;
      }
      if (response?.status === 401 || body.code === 'PRODUCT_EVENTS_ACCOUNT_CHANGED') return;
      // An unavailable link or older API keeps its source queued. Give the
      // other origins a chance in the same pass.
      if (response?.status !== 200) {
        retry = true;
        continue;
      }

      reportedSessions.add(key);
      const acknowledged = pending.filter((event) => accepted.has(event.event_id.toLowerCase()));
      if (pending.length === BATCH_SIZE && acknowledged.length === pending.length) more = true;
    }
    if (!active()) return;
    if (retry) scheduleRetry();
    else retryAttempt = 0;
    if (more) await runPass();
  }

  return {
    observeIdentity,
    observeConsent,
    recordOnboardingCompleted: recordOnboarding,
    captureDictationContext: captureContext,
    recordDictationCompleted: recordDictation,
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
  const { useOnboardingStore } =
    require('@/store/useOnboardingStore') as typeof import('@/store/useOnboardingStore');

  const instance = createProductEvents({
    storage: AsyncStorage,
    getIdentity: () => {
      const { user, sessionCookie, isGuest } = useAuthStore.getState();
      return user && sessionCookie && !isGuest
        ? { userId: user.id, isAnonymous: user.isAnonymous, cookie: sessionCookie }
        : null;
    },
    getConsent: () => {
      const { config } = useConfigStore.getState();
      return config === null ? null : isUsageAnalyticsAllowed(config);
    },
    isOnboarding: () => {
      const { hydrated, finished } = useOnboardingStore.getState();
      return !(hydrated && finished);
    },
    request: async (path, body, cookie, signal) => {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        credentials: 'omit',
        signal,
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
  const observeConsent = () => {
    instance.observeConsent().catch(() => undefined);
  };
  useConfigStore.subscribe(observeConsent);
  observeConsent();
  observe();
}

export function captureDictationContext(
  identity?: ProductEventsIdentity | null,
): ProductEventsCaptureContext {
  return (
    runtime?.captureDictationContext(identity) ?? {
      identity: null,
      isPractice: true,
      consentSignal: null,
    }
  );
}

/**
 * dictation_completed, from a dictation that delivered its text: the app's
 * own recorder (useAudioRecording) and the keyboard (useKeyboardHandoff).
 * Fire-and-forget, so it never holds up or breaks the dictation.
 */
export function recordDictationCompleted(dictation: {
  context: ProductEventsCaptureContext;
  captureId: string;
  words: number | null;
  provider: TranscriptionProvider;
  source: 'dictation' | 'keyboard';
  retranscribe: boolean;
}): void {
  runtime?.recordDictationCompleted(dictation).catch(() => undefined);
}

/** Called while the saved config is still opted out, before persisting an opt-in. */
export async function prepareProductEventsOptIn(): Promise<void> {
  initProductEvents();
  await runtime?.observeConsent();
}

/** onboarding_completed, from useOnboardingStore.finish() once completion is persisted. */
export function recordOnboardingCompleted(completion: {
  mode: ProcessingMode | null;
  replay: boolean;
  flowVersion: string;
}): void {
  runtime?.recordOnboardingCompleted(completion).catch(() => undefined);
}

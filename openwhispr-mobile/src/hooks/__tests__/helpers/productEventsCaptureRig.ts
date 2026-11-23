import {
  createProductEvents,
  type ProductEventsIdentity,
  type ProductEventsResponse,
} from '@/lib/productEvents';

export const CAPTURE_ACCOUNT: ProductEventsIdentity = {
  userId: 'capture-account',
  isAnonymous: false,
  cookie: 'capture-cookie',
};
export const NEXT_ACCOUNT: ProductEventsIdentity = {
  userId: 'next-account',
  isAnonymous: false,
  cookie: 'next-cookie',
};

interface Event {
  event_id: string;
  event_name: string;
  properties: Record<string, unknown>;
}

interface Batch {
  expected_user_id: string;
  events: Event[];
}

interface CaptureRig {
  events: ReturnType<typeof createProductEvents>;
  pending: Promise<void>[];
  signInAs(identity: ProductEventsIdentity | null): Promise<void>;
  setPractice(practice: boolean): void;
  settle(): Promise<void>;
  dictations(): { owner: string; cookie: string; properties: Record<string, unknown> }[];
  queuedDictations(): { owner_user_id: string; properties: Record<string, unknown> }[];
  countedWords(): Record<string, number>;
}

export function createProductEventsCaptureRig(): CaptureRig {
  let identity: ProductEventsIdentity | null = CAPTURE_ACCOUNT;
  let practice = false;
  let serialized: string | null = null;
  const batches: { batch: Batch; cookie: string }[] = [];
  const pending: Promise<void>[] = [];
  const events = createProductEvents({
    storage: {
      getItem: async (): Promise<string | null> => serialized,
      setItem: async (_key, value): Promise<void> => {
        serialized = value;
      },
    },
    getIdentity: () => identity,
    getConsent: () => true,
    isOnboarding: () => practice,
    request: async (path, body, cookie): Promise<ProductEventsResponse> => {
      if (path.endsWith('/app-session')) {
        return {
          status: 200,
          body: {
            binding_id: '0d6b9a52-7a3c-4c8e-9f1d-2b4a6c8e0f13',
            authenticated_at: '2026-11-04T08:00:00.000Z',
          },
        };
      }
      const batch = body as Batch;
      batches.push({ batch, cookie });
      return { status: 200, body: { accepted: batch.events.map((event) => event.event_id) } };
    },
    os: 'ios',
    appVersion: '1.2.6',
    setTimer: (): void => undefined,
  });
  return {
    events,
    pending,
    signInAs: async (next): Promise<void> => {
      identity = next;
      await events.observeIdentity();
    },
    setPractice: (next): void => {
      practice = next;
    },
    settle: async (): Promise<void> => {
      await Promise.all(pending);
      await events.flush();
    },
    dictations: () =>
      batches.flatMap(({ batch, cookie }) =>
        batch.events
          .filter((event) => event.event_name === 'dictation_completed')
          .map((event) => ({
            owner: batch.expected_user_id,
            cookie,
            properties: event.properties,
          })),
      ),
    queuedDictations: () => {
      const state = JSON.parse(serialized ?? '{}') as {
        events?: {
          event_name: string;
          owner_user_id: string;
          properties: Record<string, unknown>;
        }[];
      };
      return state.events?.filter((event) => event.event_name === 'dictation_completed') ?? [];
    },
    countedWords: () =>
      (JSON.parse(serialized ?? '{}') as { dictationWords?: Record<string, number> })
        .dictationWords ?? {},
  };
}

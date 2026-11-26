// Shared files reach Android's copies through these paths, as Metro's re-exports do.
jest.mock('@/services/transcription/TranscriptionService', () =>
  jest.requireActual('@/android/transcription/TranscriptionService'),
);
jest.mock('@/services/transcription/LocalTranscriptionService', () =>
  jest.requireActual('@/android/transcription/LocalTranscriptionService'),
);
jest.mock('@/services/transcription/parakeetSegments', () =>
  jest.requireActual('@/android/transcription/parakeetSegments'),
);
jest.mock('@/services/diarization/DiarizationService', () =>
  jest.requireActual('@/android/transcription/DiarizationService'),
);
jest.mock('@/lib/cleanupTranscript', () =>
  jest.requireActual('@/android/dictation/cleanupTranscript'),
);
jest.mock('@/lib/transcribeAndCleanup', () =>
  jest.requireActual('@/android/dictation/transcribeAndCleanup'),
);
jest.mock('@/lib/localReasoningFallback', () =>
  jest.requireActual('@/android/dictation/localReasoningFallback'),
);
jest.mock('@/lib/snippets', () => jest.requireActual('@/android/dictation/snippets'));
jest.mock('@/lib/mobileProviders', () => jest.requireActual('@/android/providers/mobileProviders'));
jest.mock('@/services/reasoning/ReasoningService', () =>
  jest.requireActual('@/android/reasoning/ReasoningService'),
);
jest.mock('@/services/reasoning/buildProviderPrompt', () =>
  jest.requireActual('@/android/reasoning/buildProviderPrompt'),
);
jest.mock('@/services/agent/composerPrompt', () =>
  jest.requireActual('@/android/reasoning/composerPrompt'),
);
jest.mock('@/data/remote/usageApi', () => jest.requireActual('@/android/remote/usageApi'));
jest.mock('@/store/useConfigStore', () => jest.requireActual('@/android/store/useConfigStore'));
jest.mock('@/store/useDictionaryStore', () =>
  jest.requireActual('@/android/store/useDictionaryStore'),
);
jest.mock('@/store/useNotesStore', () => jest.requireActual('@/android/store/useNotesStore'));
jest.mock('@/store/useSnippetsStore', () => jest.requireActual('@/android/store/useSnippetsStore'));
jest.mock('@/store/useTranscriptStore', () =>
  jest.requireActual('@/android/store/useTranscriptStore'),
);
jest.mock('@/data/local/notesRepository', () =>
  jest.requireActual('@/android/data/notesRepository'),
);
jest.mock('@/sync/pullSharedDictionary', () =>
  jest.requireActual('@/android/sync/pullSharedDictionary'),
);
jest.mock('@/sync/syncEngine', () => jest.requireActual('@/android/sync/syncEngine'));
jest.mock('@/sync/ensureNoteSynced', () => jest.requireActual('@/android/sync/ensureNoteSynced'));
jest.mock('@/db/schema', () => jest.requireActual('@/android/db/schema'));
jest.mock('@/lib/keyboardInferenceRoute', () =>
  jest.requireActual('@/android/lib/keyboardInferenceRoute'),
);
jest.mock('@/lib/meetingRecovery', () =>
  jest.requireActual('@/android/lib/meetingRecoveryAndroid'),
);
jest.mock('@/lib/notes/localMeetingNotes', () =>
  jest.requireActual('@/android/lib/notes/localMeetingNotes'),
);
jest.mock('@/hooks/useActionProcessing', () =>
  jest.requireActual('@/android/hooks/useActionProcessing'),
);
jest.mock('@/hooks/useAudioRecording', () =>
  jest.requireActual('@/android/hooks/useAudioRecording'),
);
jest.mock('@/hooks/useChatSendGate', () => jest.requireActual('@/android/hooks/useChatSendGate'));
jest.mock('@/hooks/useFileUpload', () => jest.requireActual('@/android/hooks/useFileUpload'));
jest.mock('@/hooks/useNoteSharing', () => jest.requireActual('@/android/hooks/useNoteSharing'));
jest.mock('@/hooks/useSheetDragToDismiss', () =>
  jest.requireActual('@/android/hooks/useSheetDragToDismiss'),
);
jest.mock('@/hooks/useUsageLimitRecovery', () =>
  jest.requireActual('@/android/hooks/useUsageLimitRecovery'),
);
jest.mock('@/lib/formatNoteRowTime', () => jest.requireActual('@/android/lib/formatNoteRowTime'));
jest.mock('@/lib/groupNotesByDate', () => jest.requireActual('@/android/lib/groupNotesByDate'));
jest.mock('@/lib/notes/generateNotesPrompt', () =>
  jest.requireActual('@/android/lib/notes/generateNotesPrompt'),
);
jest.mock('@/lib/notes/noteChatSuggestions', () =>
  jest.requireActual('@/android/lib/notes/noteChatSuggestions'),
);
jest.mock('@/lib/notes/noteMeta', () => jest.requireActual('@/android/lib/notes/noteMeta'));
jest.mock('@/utils/generateTitle', () => jest.requireActual('@/android/utils/generateTitle'));
jest.mock('@/lib/alerts', () => jest.requireActual('@/android/lib/alerts'));
jest.mock('@/lib/apiClient', () => jest.requireActual('@/android/lib/apiClient'));
jest.mock('@/lib/appsflyer', () => jest.requireActual('@/android/lib/appsflyer'));
jest.mock('@/lib/productEvents', () => jest.requireActual('@/android/lib/productEvents'));
jest.mock('@/lib/referralApi', () => jest.requireActual('@/android/lib/referralApi'));
jest.mock('@/lib/sentry', () => jest.requireActual('@/android/lib/sentry'));
jest.mock('@/lib/accountAccess', () => jest.requireActual('@/android/lib/accountAccess'));
jest.mock('@/lib/authClient', () => jest.requireActual('@/android/lib/authClient'));
jest.mock('@/lib/onboardingMode', () => jest.requireActual('@/android/lib/onboardingMode'));
import { reconcileStoreBilling } from '@/lib/billingReconciliation';
import { reconcileStoreBilling as reconcileAndroidStoreBilling } from '@/lib/billingReconciliation.android';
import { reconcileRevenueCatPurchases } from '@/lib/revenuecat';
import { withRevenueCatUser } from '@/lib/revenuecat.android';
import { reconcileMobileBilling } from '@/data/remote/billingApi';

let mockAuth = { user: { id: 'a' }, sessionCookie: 'cookie-a' };
let mockUsage = { billingUserId: 'billing-a' };
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: { getState: () => mockAuth } }));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ usage: mockUsage }) },
}));
jest.mock('@/android/store/useUsageStore', () => jest.requireMock('@/store/useUsageStore'));
jest.mock('@/lib/revenuecat', () => ({
  reconcileRevenueCatPurchases: jest.fn(),
}));
jest.mock('@/android/lib/revenuecat', () => ({
  ...jest.requireMock('@/lib/revenuecat'),
  ...jest.requireMock('@/lib/revenuecat.android'),
}));
jest.mock('@/lib/revenuecat.android', () => ({ withRevenueCatUser: jest.fn() }));
jest.mock('@/data/remote/billingApi', () => ({ reconcileMobileBilling: jest.fn() }));
jest.mock('@/android/shared/data/remote/billingApi', () =>
  jest.requireMock('@/data/remote/billingApi'),
);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = { user: { id: 'a' }, sessionCookie: 'cookie-a' };
  mockUsage = { billingUserId: 'billing-a' };
  jest.mocked(reconcileRevenueCatPurchases).mockResolvedValue(true);
  jest.mocked(reconcileMobileBilling).mockResolvedValue({ isSubscribed: true } as never);
});

it('shares a check only within the same account and retains its original HTTP credentials', async () => {
  const first = reconcileStoreBilling();
  expect(reconcileStoreBilling()).toBe(first);
  await first;
  expect(reconcileMobileBilling).toHaveBeenCalledWith('ios', 'cookie-a');
});

it('does not share another account’s check or send its result to the new owner', async () => {
  let release!: (value: boolean) => void;
  jest.mocked(reconcileRevenueCatPurchases).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = reconcileStoreBilling();
  const rejected = expect(first).rejects.toThrow('Billing account changed');
  await new Promise<void>((resolve) => setImmediate(resolve));
  mockAuth = { user: { id: 'b' }, sessionCookie: 'cookie-b' };
  mockUsage = { billingUserId: 'billing-b' };
  const second = reconcileStoreBilling();
  expect(second).not.toBe(first);
  release(true);
  await rejected;
  await second;
  expect(reconcileMobileBilling).toHaveBeenCalledTimes(1);
  expect(reconcileMobileBilling).toHaveBeenCalledWith('ios', 'cookie-b');
});

it('discards an HTTP response after a session change', async () => {
  jest.mocked(reconcileMobileBilling).mockImplementationOnce(async () => {
    mockAuth.sessionCookie = 'new-cookie';
    return { isSubscribed: true } as never;
  });
  await expect(reconcileStoreBilling()).rejects.toThrow('Billing account changed');
});

it('starts a fresh iOS store sync after switching away and back while requests are pending', async () => {
  const releases: (() => void)[] = [];
  jest
    .mocked(reconcileRevenueCatPurchases)
    .mockImplementation(() => new Promise((resolve) => releases.push(() => resolve(true))));
  const first = reconcileStoreBilling();
  mockAuth = { user: { id: 'b' }, sessionCookie: 'cookie-b' };
  mockUsage = { billingUserId: 'billing-b' };
  const second = reconcileStoreBilling();
  const secondOutcome = second.catch((error: Error) => error);
  mockAuth = { user: { id: 'a' }, sessionCookie: 'cookie-a' };
  mockUsage = { billingUserId: 'billing-a' };
  const third = reconcileStoreBilling();
  const startedFresh = third !== first;
  releases.forEach((release) => release());
  await Promise.all([first, third]);
  expect(await secondOutcome).toEqual(new Error('Billing account changed'));
  expect(startedFresh).toBe(true);
  expect(reconcileRevenueCatPurchases).toHaveBeenCalledTimes(3);
});

it('checks Android access without implicitly restoring store purchases', async () => {
  jest.mocked(withRevenueCatUser).mockImplementation(async (_userId, operation, check) => {
    check?.();
    return operation();
  });
  await reconcileAndroidStoreBilling();
  expect(reconcileRevenueCatPurchases).not.toHaveBeenCalled();
  expect(withRevenueCatUser).toHaveBeenCalledWith(
    'billing-a',
    expect.any(Function),
    expect.any(Function),
  );
  expect(reconcileMobileBilling).toHaveBeenCalledWith('android', 'cookie-a');
});

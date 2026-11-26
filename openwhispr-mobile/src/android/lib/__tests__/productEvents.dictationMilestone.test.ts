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
jest.mock('@/store/useAuthStore', () => jest.requireActual('@/android/store/useAuthStore'));
jest.mock('@/store/useConfigStore', () => jest.requireActual('@/android/store/useConfigStore'));
jest.mock('@/store/useDictionaryStore', () =>
  jest.requireActual('@/android/store/useDictionaryStore'),
);
jest.mock('@/store/useNotesStore', () => jest.requireActual('@/android/store/useNotesStore'));
jest.mock('@/store/useSnippetsStore', () => jest.requireActual('@/android/store/useSnippetsStore'));
jest.mock('@/store/useTranscriptStore', () =>
  jest.requireActual('@/android/store/useTranscriptStore'),
);
jest.mock('@/store/useUsageStore', () => jest.requireActual('@/android/store/useUsageStore'));
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
jest.mock('@/lib/revenuecat', () => jest.requireActual('@/android/lib/revenuecat'));
import { recordDictationCompleted } from '@/lib/productEvents';
import { recordDictationMilestone } from '@/android/lib/dictationMilestone';

jest.mock('@/android/lib/dictationMilestone', () => ({ recordDictationMilestone: jest.fn() }));

const dictation: Parameters<typeof recordDictationCompleted>[0] = {
  context: { identity: null, isPractice: false, consentSignal: null },
  captureId: 'recording-1',
  words: 12,
  provider: 'local',
  source: 'keyboard',
  retranscribe: false,
};

it('reports every finished dictation to the ad-measurement milestone as well', () => {
  recordDictationCompleted(dictation);

  expect(recordDictationMilestone).toHaveBeenCalledTimes(1);
  expect(recordDictationMilestone).toHaveBeenCalledWith(dictation);
});

import { notesRepository } from '@/data';
import { useAuthStore } from '@/android/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { getMeetingTranscriptionId } from '@/lib/notes/meetingTranscriptionId';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import type { MeetingLifecycle } from '@/android/store/createNotesStore';
import { createLocalMeetingContext } from './localMeetingContext';
import { createCloudMeetingContext } from './cloudMeetingContext';
import { meetingOnDevice } from './meetingRouting';

const latestRetryAttempts = new Map<string, symbol>();

export const androidMeetingLifecycle: MeetingLifecycle = {
  createContext: createLocalMeetingContext,
  canUseCloud: () => !meetingOnDevice(),
  // Any meeting model will do; which one is on the phone is the notes store's readiness check.
  canUseLocalAsr: () => {
    const { meetingSpeechModels } =
      require('@/android/speechSelection') as typeof import('@/android/speechSelection');
    return meetingSpeechModels().length > 0;
  },
  deferMissingModelRecovery: true,
  localGenerationOptions: (checkpoint) => ({ checkpoint }),
  async retryTranscription(note, get) {
    const noteId = note.id;
    const user = useAuthStore.getState().user;
    const attemptKey = JSON.stringify([user?.id ?? null, noteId]);
    const attempt = Symbol();
    // A newer Local or Cloud retry invalidates callbacks from older uploads.
    latestRetryAttempts.set(attemptKey, attempt);
    if (note.isPrivate || meetingOnDevice()) {
      await get().runMeetingPipeline(
        noteId,
        note.sourceFile,
        note.expectedSpeakerCount ?? undefined,
      );
      return;
    }
    if (!user || user.isAnonymous) throw new Error('Sign in to retry this meeting with Cloud.');
    const context = createCloudMeetingContext(noteId);
    try {
      context?.checkpoint();
      get().transitionStatus(noteId, 'transcribing');
      const { TranscriptionService } =
        require('@/android/transcription/TranscriptionService') as typeof import('@/android/transcription/TranscriptionService');
      const result = await TranscriptionService.transcribe({
        audioUri: note.sourceFile,
        provider: 'cloud',
        requestContext: 'file',
        purpose: 'meeting',
        clientTranscriptionId: getMeetingTranscriptionId(notesRepository, noteId),
        signal: context?.signal,
        fileName: `meeting-${noteId}.wav`,
        mimeType: 'audio/wav',
        language: getPreferredTranscriptionLanguage(),
      });
      context?.checkpoint();
      if (!result.text.trim()) throw new Error('No speech found in the recording.');
      await get().finalizeCloudMeeting(
        noteId,
        [
          {
            itemId: `recovered-${noteId}`,
            text: result.text,
            startMs: 0,
            endMs: Math.max(0, result.duration * 1000),
          },
        ],
        result.duration,
      );
    } catch (error) {
      const restoreRetry = () => {
        if (latestRetryAttempts.get(attemptKey) !== attempt) return;
        if (notesRepository.getTranscriptionStatus(noteId) === 'transcribing')
          get().transitionStatus(noteId, 'failed');
      };
      if (context.ownsSavedNote()) restoreRetry();
      else context.recoverInterruptedNoteWhenOwnerReturns(note.sourceFile, restoreRetry);
      throw error;
    } finally {
      context?.dispose();
    }
  },
};

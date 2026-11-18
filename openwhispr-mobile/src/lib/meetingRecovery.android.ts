import { meetingAudioContext } from './meetingAudioStorage';
import { repairAndroidMeetingRecordingPaths } from '@/android/meetingRecordingRepair';
import { Sentry } from './sentry';
import { useNotesStore } from '@/store/useNotesStore';

// The explicit extension loads the unchanged default implementation. Eager loading
// preserves its process-start cutoff before this asynchronous account scan begins.
const baseline = require('./meetingRecovery.ts') as typeof import('./meetingRecovery.ts');
export const {
  MEETING_RESUME_MARKER_PREFIX,
  recoverOrphanedMeetings,
  repairMeetingRecordings,
  waitForAppActive,
  createdBeforeRuntime,
} = baseline;
export type { MeetingRecoveryDeps, MeetingRecordingRepairDeps } from './meetingRecovery.ts';

const started = new Set<string>();
export function startMeetingRecoveryOnce(): void {
  const audio = meetingAudioContext();
  if (started.has(audio.key)) return;
  started.add(audio.key);
  repairAndroidMeetingRecordingPaths(audio)
    .catch((error) => Sentry.captureException(error, { tags: { feature: 'meeting-recovery' } }))
    .then(() => {
      if (!audio.isCurrent()) return;
      // Failed notes may already be open when the asynchronous path repair finishes.
      try {
        useNotesStore.getState().loadNotes();
      } catch (error) {
        Sentry.captureException(error, { tags: { feature: 'meeting-recovery' } });
      }
      baseline.startMeetingRecoveryOnce();
    })
    .catch(Sentry.captureException);
}

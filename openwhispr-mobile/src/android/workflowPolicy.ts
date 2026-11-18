import type { InferenceMode, UserConfig } from '@/types';
import type { MobileInferenceScope } from '@/lib/mobileProviders';
import { MODE_LABELS } from '@/lib/inferenceModes';
import type { AiWorkflowPolicy } from '../lib/aiWorkflowsCore';

export const PRIVATE_MODE_LOCKED_REASON =
  'Off while Local Mode is on. Turn it off in Models & processing.';
export const ANDROID_LOCAL_MODE_LOCKED: Partial<Record<MobileInferenceScope, InferenceMode[]>> = {
  dictation: ['openwhispr'],
  upload: ['openwhispr', 'providers'],
  cleanup: ['openwhispr'],
};
export function cleanupSavedOnDevice(config: UserConfig | null): boolean {
  return config?.inference?.cleanup?.mode === 'local';
}

export const androidWorkflowPolicy: AiWorkflowPolicy = {
  copy: {
    onDeviceCleanupUnsupported:
      'On-device cleanup is unavailable. Your raw transcript stays on this phone.',
    localModeDictationNotes: {
      on: 'Local Mode keeps dictation on this phone. Turn it off in Models & processing to use Cloud, or choose Bring Your Own Key.',
      off: 'On-Device turns on Local Mode: dictation stays on this phone and notes ask before leaving it.',
    },
    onDeviceModeNotes: {
      upload: 'Local Mode keeps uploads on this phone.',
      notes:
        'Local Mode formats notes on this phone and asks before sending one to your choice here.',
      agent: 'In Local Mode the voice assistant is off.',
      cleanup:
        'In Local Mode, cleanup runs on this phone, or sends only the transcript text to your provider with Bring Your Own Key. OpenWhispr Cloud cleanup is skipped until Local Mode is off.',
      noteChat: 'In Local Mode note chat asks before sending a note off this phone.',
    },
    cloudCleanupNeedsAccount:
      'OpenWhispr Cloud cleans transcripts made on this phone or with your own key only for a signed-in account, so cleanup is skipped until you sign in.',
  },
  cloudCleanupNeedsAccount: () => false,
  cleanupRunsOnDevice: cleanupSavedOnDevice,
  keepCloudPinsInLocalMode: true,
  voiceAssistantBlocked: (activeMode) => activeMode === 'private',
  summaryOverride: (config, scope, activeMode) => {
    if (activeMode !== 'private') return undefined;
    if (
      scope === 'cleanup' &&
      !['local', 'providers'].includes(config?.inference?.cleanup?.mode ?? '')
    )
      return 'Skipped';
    if (scope === 'upload' || scope === 'notes') return MODE_LABELS.local;
    return undefined;
  },
};

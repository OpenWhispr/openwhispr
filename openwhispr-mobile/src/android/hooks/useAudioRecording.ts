import { useAndroidRecordingLifecycle } from '@/android/useAndroidRecordingLifecycle';
import {
  useAudioRecordingCore,
  type UseAudioRecordingOptions,
} from '@/android/hooks/useAudioRecordingCore';

export type { UseAudioRecordingOptions } from '@/android/hooks/useAudioRecordingCore';

export function useAudioRecording(options: UseAudioRecordingOptions = {}) {
  const { recording, lifecycle } = useAudioRecordingCore(options, useAndroidRecordingLifecycle);
  return { isStarting: lifecycle.isStarting, ...recording };
}

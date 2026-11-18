import { useAudioRecordingCore, type UseAudioRecordingOptions } from './useAudioRecordingCore';

export type { UseAudioRecordingOptions } from './useAudioRecordingCore';

function useDefaultLifecycle() {
  return undefined;
}

export function useAudioRecording(options: UseAudioRecordingOptions = {}) {
  const { recording } = useAudioRecordingCore(options, useDefaultLifecycle);
  return {
    ...recording,
    stopRecording: recording.stopRecording as () => Promise<void>,
  };
}

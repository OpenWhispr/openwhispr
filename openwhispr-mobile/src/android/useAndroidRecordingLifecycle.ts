import { useEffect, useRef, useState } from 'react';
import type { AudioRecordingLifecycle } from '../hooks/useAudioRecordingCore';

export function useAndroidRecordingLifecycle(): AudioRecordingLifecycle {
  const [isStarting, setIsStarting] = useState(false);
  const generation = useRef(0);
  const starting = useRef(false);
  const stopping = useRef(false);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  return {
    isStarting,
    unavailableMessage:
      'Audio recording is unavailable in this build. Install the full app to record.',
    missingFileMessage: 'Recording file was not created. Please try recording again.',
    successfulStop: true,
    beginStart(state) {
      const cancelledError = () =>
        Object.assign(new Error('Recording cancelled'), { name: 'AbortError' });
      if (
        starting.current ||
        stopping.current ||
        state.stopping ||
        state.isRecording ||
        state.isProcessing
      )
        throw cancelledError();
      starting.current = true;
      setIsStarting(true);
      const run = ++generation.current;
      const cancelled = () => run !== generation.current;
      return {
        prepared: false,
        cancelled,
        check() {
          if (cancelled()) throw cancelledError();
        },
        finish() {
          starting.current = false;
          if (!cancelled()) setIsStarting(false);
        },
      };
    },
    beginStop(state) {
      if (stopping.current || state.stopping || !state.isRecording) return false;
      stopping.current = true;
      return true;
    },
    endStop() {
      stopping.current = false;
    },
    cancelStart() {
      generation.current += 1;
      setIsStarting(false);
    },
    blocksRawStop(nativeStop) {
      return nativeStop || stopping.current;
    },
    failedRecordingIdentity(clientTranscriptionId) {
      return { clientTranscriptionId };
    },
  };
}

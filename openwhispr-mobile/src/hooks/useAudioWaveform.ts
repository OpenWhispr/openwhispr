import { useState, useEffect, useRef, useCallback } from 'react';
import {
  KEYBOARD_RECORDING_WAVEFORM,
  normalizeDbToKeyboardLevel,
  smoothKeyboardRecordingLevel,
} from '@/lib/recordingWaveformPattern';

export function useAudioWaveform(
  audioRecorder: { getStatus: () => { metering?: number } } | null | undefined,
  isRecording: boolean,
) {
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [currentAmplitude, setCurrentAmplitude] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const smoothedAmplitudeRef = useRef(0);

  const stopMonitoring = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    smoothedAmplitudeRef.current = 0;
    setCurrentAmplitude(0);
  }, []);

  useEffect(() => {
    if (!isRecording || !audioRecorder) {
      stopMonitoring();
      return;
    }

    setWaveformData([]);

    intervalRef.current = setInterval(() => {
      try {
        const status = audioRecorder.getStatus();
        const dbLevel = status.metering ?? KEYBOARD_RECORDING_WAVEFORM.meteringMinDb;
        const normalizedLevel = normalizeDbToKeyboardLevel(dbLevel);
        const previous = smoothedAmplitudeRef.current;
        const smoothed = smoothKeyboardRecordingLevel(normalizedLevel, previous);
        smoothedAmplitudeRef.current = smoothed;

        setCurrentAmplitude(smoothed);
        setWaveformData((prev) => [
          ...prev.slice(-(KEYBOARD_RECORDING_WAVEFORM.barCount - 1)),
          smoothed,
        ]);
      } catch {
        // Recorder may not be ready yet
      }
    }, KEYBOARD_RECORDING_WAVEFORM.pollIntervalMs);

    return stopMonitoring;
  }, [isRecording, audioRecorder, stopMonitoring]);

  const reset = useCallback(() => {
    setWaveformData([]);
    setCurrentAmplitude(0);
  }, []);

  return { waveformData, currentAmplitude, reset };
}

import { useEffect } from "react";
import {
  getMicAnalyser,
  primeMeetingWorklet,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";

// EMA factor 0.7 prefers the previous level so visual bars don't twitch on
// noisy sub-frame samples. The 0.3 weight on the new RMS is enough to track
// fast onsets (vowels, plosives) without lag.
const EMA_PREV = 0.7;
const EMA_NEXT = 0.3;

export default function MeetingRecordingMount(): null {
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);

  useEffect(() => {
    primeMeetingWorklet();
  }, []);

  useEffect(() => {
    if (!isRecording) return;

    let rafId = 0;
    let smoothed = 0;
    const buf = new Float32Array(128);

    const tick = () => {
      const analyser = getMicAnalyser();
      if (analyser) {
        const len = Math.min(buf.length, analyser.fftSize);
        const view = len === buf.length ? buf : buf.subarray(0, len);
        analyser.getFloatTimeDomainData(view);
        let sumSquares = 0;
        for (let i = 0; i < len; i++) {
          const v = view[i];
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / len);
        smoothed = EMA_PREV * smoothed + EMA_NEXT * rms;
        const clamped = smoothed < 0 ? 0 : smoothed > 1 ? 1 : smoothed;
        useMeetingRecordingStore.setState({ currentMicLevel: clamped });
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      useMeetingRecordingStore.setState({ currentMicLevel: 0 });
    };
  }, [isRecording]);

  return null;
}

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import {
  getMicAnalyser,
  primeMeetingWorklet,
  stopRecording as stopMeetingRecording,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";
import { useSettingsStore } from "../stores/settingsStore";

const EMA_PREV = 0.5;
const EMA_NEXT = 0.5;

// Auto-end a meeting recording after this much silence (no mic or system-audio
// speech). The overlay then shows an interruptible countdown.
const SILENCE_THRESHOLD_MS = 60 * 1000;
const SILENCE_CHECK_INTERVAL_MS = 2 * 1000;
const END_COUNTDOWN_MS = 5 * 1000;

export default function MeetingRecordingMount(): null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const error = useMeetingRecordingStore((s) => s.error);
  const micCaptureStatus = useMeetingRecordingStore((s) => s.micCaptureStatus);
  const wasMicUnavailable = useRef(false);

  useEffect(() => {
    primeMeetingWorklet();
  }, []);

  useEffect(() => {
    if (!error) return;
    toast({
      title: t("notes.meeting.title"),
      description: error,
      variant: "destructive",
    });
  }, [error, toast, t]);

  useEffect(() => {
    if (micCaptureStatus === "unavailable" && !wasMicUnavailable.current) {
      wasMicUnavailable.current = true;
      toast({
        title: t("hooks.audioRecording.micDisconnected.title"),
        description: t("hooks.audioRecording.micDisconnected.meetingDescription"),
        variant: "default",
      });
    } else if (micCaptureStatus === "active" && wasMicUnavailable.current) {
      wasMicUnavailable.current = false;
      toast({
        title: t("hooks.audioRecording.micRestored.title"),
        description: t("hooks.audioRecording.micRestored.description"),
        variant: "default",
      });
    } else if (micCaptureStatus === "inactive") {
      wasMicUnavailable.current = false;
    }
  }, [micCaptureStatus, toast, t]);

  useEffect(() => {
    if (!isRecording) return;

    let rafId = 0;
    let smoothed = 0;
    let buf = new Float32Array(256);

    const tick = () => {
      const analyser = getMicAnalyser();
      if (analyser) {
        if (buf.length !== analyser.fftSize) {
          buf = new Float32Array(analyser.fftSize);
        }
        analyser.getFloatTimeDomainData(buf);
        let sumSquares = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / buf.length);
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

  // Silence-based auto-end: watch for mic/system speech activity; after
  // SILENCE_THRESHOLD_MS with none, show the interruptible "ending?" overlay.
  const lastActivityRef = useRef(0);
  const promptShowingRef = useRef(false);

  useEffect(() => {
    if (!isRecording) return;

    lastActivityRef.current = Date.now();
    promptShowingRef.current = false;

    const onActivity = () => {
      lastActivityRef.current = Date.now();
      // Speech resumed while the "ending?" prompt was up — cancel it and keep
      // recording (no need to wait for the countdown).
      if (promptShowingRef.current) {
        promptShowingRef.current = false;
        window.electronAPI?.dismissMeetingEndPrompt?.();
      }
    };

    // A new mic/system partial or a newly finalized segment means someone just
    // spoke. currentMicLevel changes every frame, so it is intentionally not
    // treated as speech here (it would include ambient noise).
    const unsubscribe = useMeetingRecordingStore.subscribe((state, prev) => {
      if (
        state.micPartial !== prev.micPartial ||
        state.systemPartial !== prev.systemPartial ||
        state.segments.length !== prev.segments.length
      ) {
        onActivity();
      }
    });

    const interval = setInterval(() => {
      if (promptShowingRef.current) return;
      if (!useSettingsStore.getState().autoEndMeetingRecording) return;
      if (!useMeetingRecordingStore.getState().isRecording) return;
      if (Date.now() - lastActivityRef.current < SILENCE_THRESHOLD_MS) return;

      promptShowingRef.current = true;
      window.electronAPI?.showMeetingEndPrompt?.({ countdownMs: END_COUNTDOWN_MS });
    }, SILENCE_CHECK_INTERVAL_MS);

    const cleanupResponse = window.electronAPI?.onMeetingEndResponse?.(
      (data: { action: string }) => {
        promptShowingRef.current = false;
        if (data?.action === "end") {
          stopMeetingRecording().catch(() => {
            // stop failures are surfaced via the recording store's error state
          });
        } else {
          // "keep" — reset the silence window so we don't immediately re-prompt.
          lastActivityRef.current = Date.now();
        }
      }
    );

    return () => {
      unsubscribe();
      clearInterval(interval);
      cleanupResponse?.();
      if (promptShowingRef.current) {
        promptShowingRef.current = false;
        window.electronAPI?.dismissMeetingEndPrompt?.();
      }
    };
  }, [isRecording]);

  return null;
}

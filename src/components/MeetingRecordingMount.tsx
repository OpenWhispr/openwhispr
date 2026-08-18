import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import {
  getActiveRecordingSessionId,
  getMicAnalyser,
  primeMeetingWorklet,
  stopRecording,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";
import { requestMeetingRecordingAutoEnd } from "../helpers/meetingRecordingSession";
import { serializeTranscriptSegments } from "../utils/transcriptSpeakerState";
import logger from "../utils/logger";

const EMA_PREV = 0.5;
const EMA_NEXT = 0.5;

// Sentinel errors set by meetingRecordingStore, translated at display time.
const MEETING_ERROR_KEYS: Record<string, string> = {
  policyRestricted: "notes.meeting.restrictedByOrg",
};

export default function MeetingRecordingMount(): null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const isTranscribing = useMeetingRecordingStore((s) => s.isTranscribing);
  const error = useMeetingRecordingStore((s) => s.error);
  const errorNonce = useMeetingRecordingStore((s) => s.errorNonce);
  const micCaptureStatus = useMeetingRecordingStore((s) => s.micCaptureStatus);
  const wasMicUnavailable = useRef(false);

  useEffect(() => {
    primeMeetingWorklet();
  }, []);

  useEffect(() => {
    return window.electronAPI?.onMeetingAutoEndRequested?.((request) => {
      requestMeetingRecordingAutoEnd(
        request,
        (sessionId) => {
          // Toast only when this request actually ends the live session — and
          // even if the user's Keep click lost the race with the countdown, so
          // they learn the recording ended rather than assuming it was kept.
          const endsActiveSession = getActiveRecordingSessionId() === sessionId;
          return stopRecording(sessionId).then((result) => {
            if (endsActiveSession) {
              toast({
                title: t("notes.meeting.title"),
                description: t("notes.meeting.autoEnded"),
              });
            }
            return result;
          });
        },
        (error, sessionId) => {
          logger.error(
            "Meeting auto-end stop failed; recording is still running",
            { error: error instanceof Error ? error.message : String(error), sessionId },
            "meeting"
          );
        }
      );
    });
  }, [toast, t]);

  // Crash-safety net moved out of the notes view: it must keep running when
  // the user switches views mid-recording.
  useEffect(() => {
    if (!isTranscribing) return;

    const interval = setInterval(() => {
      const { recordingNoteId, segments } = useMeetingRecordingStore.getState();
      if (!recordingNoteId || segments.length === 0) return;
      window.electronAPI.updateNote(recordingNoteId, {
        transcript: serializeTranscriptSegments(segments),
      });
    }, 30_000);

    return () => clearInterval(interval);
  }, [isTranscribing]);

  useEffect(() => {
    if (!error) return;
    toast({
      title: t("notes.meeting.title"),
      description: MEETING_ERROR_KEYS[error] ? t(MEETING_ERROR_KEYS[error]) : error,
      variant: "destructive",
    });
    // errorNonce re-fires this toast when the same error repeats back-to-back.
  }, [error, errorNonce, toast, t]);

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

  return null;
}

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import {
  getActiveRecordingSessionId,
  getMicAnalyser,
  primeMeetingWorklet,
  startRecording,
  stopRecording,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";
import {
  createMeetingAutoEndRestartContext,
  requestMeetingRecordingAutoEnd,
  runMeetingAutoEndRestart,
  type MeetingAutoEndRestartContext,
} from "../helpers/meetingRecordingSession";
import { parseTranscriptSegments } from "../utils/parseTranscriptSegments";
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
  const systemAudioSilentWarning = useMeetingRecordingStore((s) => s.systemAudioSilentWarning);
  const micCaptureStatus = useMeetingRecordingStore((s) => s.micCaptureStatus);
  const wasMicUnavailable = useRef(false);
  const wasSystemAudioSilent = useRef(false);
  const pendingAutoEndRestart = useRef<MeetingAutoEndRestartContext | null>(null);
  // The auto-end listeners are registered once, so they cannot close over `t`
  // or `toast` directly without pinning the language they mounted with.
  const notifyAutoEnded = useRef<() => void>(() => {});
  const notifyRestartFailed = useRef<() => void>(() => {});

  useEffect(() => {
    notifyAutoEnded.current = () => {
      toast({ title: t("notes.meeting.title"), description: t("notes.meeting.autoEnded") });
    };
    notifyRestartFailed.current = () => {
      toast({
        title: t("notes.meeting.title"),
        description: t("notes.meeting.restartFailed"),
        variant: "destructive",
      });
    };
  }, [toast, t]);

  useEffect(() => {
    primeMeetingWorklet();
  }, []);

  useEffect(() => {
    const unsubscribeStop = window.electronAPI?.onMeetingAutoEndRequested?.((request) => {
      const restartContext = createMeetingAutoEndRestartContext(
        request.sessionId,
        getActiveRecordingSessionId(),
        useMeetingRecordingStore.getState()
      );
      if (!restartContext) return;

      requestMeetingRecordingAutoEnd(
        request,
        stopRecording,
        (sessionId, stopped) => {
          // Every path that ends the recording without offering a restart card
          // has to say so, or the recording just disappears.
          const abandonRestart = () => {
            if (pendingAutoEndRestart.current?.sessionId === sessionId) {
              pendingAutoEndRestart.current = null;
            }
            notifyAutoEnded.current();
          };

          const completion = window.electronAPI?.meetingAutoEndCompleted;
          if (!stopped || !completion) {
            abandonRestart();
            return;
          }

          pendingAutoEndRestart.current = restartContext;
          void completion(sessionId)
            .then((result) => {
              if (!result.success) abandonRestart();
            })
            .catch((error) => {
              abandonRestart();
              logger.error(
                "Meeting auto-end completion acknowledgment failed",
                { error: error instanceof Error ? error.message : String(error), sessionId },
                "meeting"
              );
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

    const unsubscribeRestart = window.electronAPI?.onMeetingAutoEndRestartRequested?.((request) => {
      const context = pendingAutoEndRestart.current;
      pendingAutoEndRestart.current = null;

      void runMeetingAutoEndRestart(request, context, {
        getActiveSessionId: getActiveRecordingSessionId,
        getLatestSegments: () => useMeetingRecordingStore.getState().segments,
        getNote: (noteId) => window.electronAPI?.getNote?.(noteId) ?? Promise.resolve(null),
        parseSegments: parseTranscriptSegments,
        startRecording,
      })
        .then((outcome) => {
          // Main already closed the card and reported success, so an abort the
          // user is not told about looks exactly like a restart that worked.
          if (outcome.status === "started") return;
          logger.error(
            "Meeting recording restart aborted",
            { reason: outcome.reason, sessionId: request.sessionId },
            "meeting"
          );
          notifyRestartFailed.current();
        })
        .catch((error) => {
          logger.error(
            "Meeting recording restart failed",
            { error: error instanceof Error ? error.message : String(error) },
            "meeting"
          );
          notifyRestartFailed.current();
        });
    });

    return () => {
      unsubscribeStop?.();
      unsubscribeRestart?.();
    };
  }, []);

  useEffect(() => {
    if (isRecording) pendingAutoEndRestart.current = null;
  }, [isRecording]);

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

  // The store latches this once per recording; the ref keeps dependency
  // changes (e.g. a language switch recreating `t`) from re-firing the toast.
  useEffect(() => {
    if (!systemAudioSilentWarning) {
      wasSystemAudioSilent.current = false;
      return;
    }
    if (wasSystemAudioSilent.current) return;
    wasSystemAudioSilent.current = true;
    toast({
      title: t("notes.meeting.systemAudioSilent.title"),
      description: t("notes.meeting.systemAudioSilent.description"),
      duration: 8000,
    });
  }, [systemAudioSilentWarning, toast, t]);

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

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import {
  getMicAnalyser,
  primeMeetingWorklet,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";

const EMA_PREV = 0.5;
const EMA_NEXT = 0.5;

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

  return null;
}

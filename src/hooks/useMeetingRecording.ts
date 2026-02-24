import { useState, useEffect, useRef, useCallback } from "react";
import logger from "../utils/logger";
import type { CalendarEvent } from "../types/calendar";

const SAFETY_TIMEOUT_BUFFER_MS = 30 * 60 * 1000;

interface UseMeetingRecordingReturn {
  isRecording: boolean;
  isProcessing: boolean;
  activeMeeting: CalendarEvent | null;
  startRecording: (event: CalendarEvent) => Promise<void>;
  stopRecording: () => Promise<void>;
}

const getSystemAudioStream = async (): Promise<MediaStream | null> => {
  try {
    const sources = await window.electronAPI?.getDesktopSources(["screen"]);
    if (!sources?.length) return null;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sources[0].id,
        },
      } as any,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sources[0].id,
          minWidth: 1,
          maxWidth: 1,
          minHeight: 1,
          maxHeight: 1,
        },
      } as any,
    });

    stream.getVideoTracks().forEach((t) => t.stop());
    return new MediaStream(stream.getAudioTracks());
  } catch (err) {
    logger.error("Failed to capture system audio", { error: (err as Error).message }, "meeting");
    return null;
  }
};

export function useMeetingRecording(): UseMeetingRecordingReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeMeeting, setActiveMeeting] = useState<CalendarEvent | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartTimeRef = useRef<number | null>(null);
  const safetyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeMeetingRef = useRef<CalendarEvent | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current);
      safetyTimeoutRef.current = null;
    }
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    recordingStartTimeRef.current = null;
  }, []);

  const stopRecording = useCallback(async () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") return;

    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current);
      safetyTimeoutRef.current = null;
    }

    return new Promise<void>((resolve) => {
      const recorder = mediaRecorderRef.current!;
      const event = activeMeetingRef.current;
      const mimeType = recorder.mimeType || "audio/webm";

      recorder.onstop = async () => {
        setIsRecording(false);
        setIsProcessing(true);

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const durationSeconds = recordingStartTimeRef.current
          ? (Date.now() - recordingStartTimeRef.current) / 1000
          : 0;

        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        mediaRecorderRef.current = null;
        audioChunksRef.current = [];
        recordingStartTimeRef.current = null;

        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const result = await window.electronAPI?.cloudTranscribe(arrayBuffer, {
            useCase: "meeting" as any,
            diarization: true as any,
          });

          if (result?.success && result.text) {
            const title = event?.summary || "Meeting Recording";
            const noteResult = await window.electronAPI?.saveNote(
              title,
              "",
              "meeting",
              null,
              Math.round(durationSeconds),
              null
            );

            if (noteResult?.success && noteResult.note) {
              await window.electronAPI?.updateNote(noteResult.note.id, {
                transcript: result.text,
                calendar_event_id: event?.id ?? null,
              });
              logger.info(
                "Meeting transcription saved",
                { noteId: noteResult.note.id, eventId: event?.id },
                "meeting"
              );
            }
          } else {
            logger.error("Meeting transcription failed", { error: result?.error }, "meeting");
          }
        } catch (err) {
          logger.error(
            "Meeting recording processing failed",
            { error: (err as Error).message },
            "meeting"
          );
        } finally {
          setIsProcessing(false);
          setActiveMeeting(null);
          activeMeetingRef.current = null;
          resolve();
        }
      };

      recorder.stop();
    });
  }, []);

  const startRecording = useCallback(
    async (event: CalendarEvent) => {
      if (isRecording || isProcessing) return;

      const stream = await getSystemAudioStream();
      if (!stream) {
        logger.error("Could not capture system audio for meeting", {}, "meeting");
        return;
      }

      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recordingStartTimeRef.current = Date.now();
      activeMeetingRef.current = event;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.start();
      setIsRecording(true);
      setActiveMeeting(event);

      const eventDurationMs =
        new Date(event.end_time).getTime() - new Date(event.start_time).getTime();
      const safetyMs = Math.max(eventDurationMs, 0) + SAFETY_TIMEOUT_BUFFER_MS;

      safetyTimeoutRef.current = setTimeout(() => {
        logger.info("Safety timeout reached, auto-stopping meeting recording", {}, "meeting");
        stopRecording();
      }, safetyMs);

      logger.info(
        "Meeting recording started",
        { eventId: event.id, summary: event.summary },
        "meeting"
      );
    },
    [isRecording, isProcessing, stopRecording]
  );

  useEffect(() => {
    const cleanups: Array<() => void> = [];

    const meetingStartingCleanup = window.electronAPI?.onGcalMeetingStarting?.((data: any) => {
      logger.info("Meeting starting notification", { eventId: data?.event?.id }, "meeting");
    });
    if (meetingStartingCleanup) cleanups.push(meetingStartingCleanup);

    const meetingEndedCleanup = window.electronAPI?.onGcalMeetingEnded?.((data: any) => {
      if (activeMeetingRef.current && data?.event?.id === activeMeetingRef.current.id) {
        logger.info(
          "Meeting ended, auto-stopping recording",
          { eventId: data.event.id },
          "meeting"
        );
        stopRecording();
      }
    });
    if (meetingEndedCleanup) cleanups.push(meetingEndedCleanup);

    const startRecordingCleanup = window.electronAPI?.onGcalStartRecording?.((data: any) => {
      if (data?.event && !activeMeetingRef.current) {
        startRecording(data.event);
      }
    });
    if (startRecordingCleanup) cleanups.push(startRecordingCleanup);

    return () => {
      cleanups.forEach((fn) => fn());
      cleanup();
    };
  }, [startRecording, stopRecording, cleanup]);

  return {
    isRecording,
    isProcessing,
    activeMeeting,
    startRecording,
    stopRecording,
  };
}

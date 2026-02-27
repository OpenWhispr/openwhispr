import { useState, useEffect, useRef, useCallback } from "react";
import logger from "../utils/logger";

interface UseMeetingTranscriptionReturn {
  isRecording: boolean;
  transcript: string;
  partialTranscript: string;
  error: string | null;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<void>;
}

const getSystemAudioStream = async (): Promise<MediaStream | null> => {
  try {
    // Use getDisplayMedia (handled by setDisplayMediaRequestHandler in main process)
    // which properly captures system audio via macOS ScreenCaptureKit loopback.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();

    if (!audioTracks.length) {
      logger.error("No audio track in display media stream", {}, "meeting");
      videoTracks.forEach((t) => t.stop());
      return null;
    }

    // Stop video tracks — with getDisplayMedia the audio track lifecycle is independent
    videoTracks.forEach((t) => t.stop());

    // Monitor audio track health
    audioTracks[0].addEventListener("ended", () => {
      logger.error("Audio track ended unexpectedly", {}, "meeting");
    });

    const audioOnlyStream = new MediaStream(audioTracks);
    return audioOnlyStream;
  } catch (err) {
    logger.error("Failed to capture system audio", { error: (err as Error).message }, "meeting");
    return null;
  }
};

export function useMeetingTranscription(): UseMeetingTranscriptionReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const isStartingRef = useRef(false);
  const ipcCleanupsRef = useRef<Array<() => void>>([]);

  const cleanup = useCallback(async () => {
    if (scriptNodeRef.current) {
      scriptNodeRef.current.onaudioprocess = null;
      scriptNodeRef.current.disconnect();
      scriptNodeRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      try {
        await audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }

    ipcCleanupsRef.current.forEach((fn) => fn());
    ipcCleanupsRef.current = [];
  }, []);

  const stopTranscription = useCallback(async () => {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;
    setIsRecording(false);

    await cleanup();

    try {
      const result = await window.electronAPI?.meetingTranscriptionStop?.();
      if (result?.success && result.transcript) {
        setTranscript(result.transcript);
      } else if (result?.error) {
        setError(result.error);
      }
    } catch (err) {
      setError((err as Error).message);
      logger.error(
        "Meeting transcription stop failed",
        { error: (err as Error).message },
        "meeting"
      );
    }

    logger.info("Meeting transcription stopped", {}, "meeting");
  }, [cleanup]);

  const startTranscription = useCallback(async () => {
    if (isRecordingRef.current || isStartingRef.current) return;
    isStartingRef.current = true;

    logger.info("Meeting transcription starting...", {}, "meeting");

    try {
      const startResult = await window.electronAPI?.meetingTranscriptionStart?.({
        provider: "openai-realtime",
        model: "gpt-4o-mini-transcribe",
      });
      if (!startResult?.success) {
        logger.error(
          "Meeting transcription IPC start failed",
          { error: startResult?.error },
          "meeting"
        );
        isStartingRef.current = false;
        return;
      }

      const stream = await getSystemAudioStream();
      if (!stream) {
        logger.error("Could not capture system audio for meeting transcription", {}, "meeting");
        await window.electronAPI?.meetingTranscriptionStop?.();
        isStartingRef.current = false;
        return;
      }
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 24000 });
      audioContextRef.current = audioContext;

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
      scriptNodeRef.current = scriptNode;

      setTranscript("");
      setPartialTranscript("");
      setError(null);

      const partialCleanup = window.electronAPI?.onMeetingTranscriptionPartial?.((text) => {
        setPartialTranscript(text);
      });
      if (partialCleanup) ipcCleanupsRef.current.push(partialCleanup);

      const finalCleanup = window.electronAPI?.onMeetingTranscriptionFinal?.((text) => {
        setTranscript(text);
        setPartialTranscript("");
      });
      if (finalCleanup) ipcCleanupsRef.current.push(finalCleanup);

      const errorCleanup = window.electronAPI?.onMeetingTranscriptionError?.((err) => {
        setError(err);
        logger.error("Meeting transcription stream error", { error: err }, "meeting");
      });
      if (errorCleanup) ipcCleanupsRef.current.push(errorCleanup);

      scriptNode.onaudioprocess = (event) => {
        if (!isRecordingRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        window.electronAPI?.meetingTranscriptionSend?.(pcm.buffer);
      };

      source.connect(scriptNode);
      scriptNode.connect(audioContext.destination);

      isRecordingRef.current = true;
      isStartingRef.current = false;
      setIsRecording(true);
      logger.info("Meeting transcription started successfully", {}, "meeting");
    } catch (err) {
      logger.error(
        "Meeting transcription setup failed",
        { error: (err as Error).message },
        "meeting"
      );
      isStartingRef.current = false;
      await cleanup();
    }
  }, [cleanup]);

  useEffect(() => {
    return () => {
      if (isRecordingRef.current) {
        isRecordingRef.current = false;
        cleanup();
      }
    };
  }, [cleanup]);

  return {
    isRecording,
    transcript,
    partialTranscript,
    error,
    startTranscription,
    stopTranscription,
  };
}

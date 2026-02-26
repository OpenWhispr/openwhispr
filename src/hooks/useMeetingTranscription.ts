import { useState, useEffect, useRef, useCallback } from "react";
import logger from "../utils/logger";
import { buildWav } from "../utils/wavBuilder";
import { OPENWHISPR_API_URL } from "../config/constants";

interface UseMeetingTranscriptionReturn {
  isRecording: boolean;
  isProcessing: boolean;
  transcript: string;
  error: string | null;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<void>;
}

const WORKLET_CODE = `
const BUFFER_SIZE = 800;
class PCMStreamingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this.port.postMessage(partial.buffer, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
        }
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-meeting-processor", PCMStreamingProcessor);
`;

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

export function useMeetingTranscription(): UseMeetingTranscriptionReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const workletBlobUrlRef = useRef<string | null>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);

  const cleanup = useCallback(async () => {
    if (processorRef.current) {
      processorRef.current.port.postMessage("stop");
      processorRef.current.disconnect();
      processorRef.current = null;
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

    if (workletBlobUrlRef.current) {
      URL.revokeObjectURL(workletBlobUrlRef.current);
      workletBlobUrlRef.current = null;
    }
  }, []);

  const stopTranscription = useCallback(async () => {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;
    setIsRecording(false);

    await cleanup();

    const chunks = chunksRef.current;
    chunksRef.current = [];

    if (chunks.length === 0) {
      logger.info("Meeting transcription stopped (no audio captured)", {}, "meeting");
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const totalLength = chunks.reduce((sum, buf) => sum + buf.byteLength / 2, 0);
      const allSamples = new Int16Array(totalLength);
      let offset = 0;
      for (const buf of chunks) {
        const chunk = new Int16Array(buf);
        allSamples.set(chunk, offset);
        offset += chunk.length;
      }

      const wavBlob = buildWav(allSamples, 16000);

      const { upload } = await import("@vercel/blob/client");
      const blob = await upload(`meeting-${Date.now()}.wav`, wavBlob, {
        access: "public",
        handleUploadUrl: `${OPENWHISPR_API_URL}/api/upload-audio`,
      });

      const result = await window.electronAPI?.meetingTranscribeChain(blob.url);

      if (result?.success) {
        setTranscript(result.text);
      } else {
        setError(result?.error || "Transcription failed");
      }
    } catch (err) {
      setError((err as Error).message);
      logger.error("Meeting transcription failed", { error: (err as Error).message }, "meeting");
    } finally {
      setIsProcessing(false);
    }

    logger.info("Meeting transcription stopped", {}, "meeting");
  }, [cleanup]);

  const startTranscription = useCallback(async () => {
    if (isRecordingRef.current) return;

    logger.info("Meeting transcription starting...", {}, "meeting");

    const stream = await getSystemAudioStream();
    if (!stream) {
      logger.error("Could not capture system audio for meeting transcription", {}, "meeting");
      return;
    }
    logger.info(
      "System audio stream captured",
      { tracks: stream.getAudioTracks().length },
      "meeting"
    );
    streamRef.current = stream;

    try {
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const blobUrl = URL.createObjectURL(
        new Blob([WORKLET_CODE], { type: "application/javascript" })
      );
      workletBlobUrlRef.current = blobUrl;
      await audioContext.audioWorklet.addModule(blobUrl);

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = new AudioWorkletNode(audioContext, "pcm-meeting-processor");
      processorRef.current = processor;

      chunksRef.current = [];
      setTranscript("");
      setError(null);

      let chunkCount = 0;
      processor.port.onmessage = (event) => {
        if (!isRecordingRef.current) return;
        chunkCount++;
        if (chunkCount <= 3 || chunkCount % 50 === 0) {
          logger.debug(
            "Audio chunk buffered",
            { chunk: chunkCount, bytes: event.data.byteLength },
            "meeting"
          );
        }
        chunksRef.current.push(event.data);
      };

      source.connect(processor);

      isRecordingRef.current = true;
      setIsRecording(true);
      logger.info("Meeting transcription started successfully", {}, "meeting");
    } catch (err) {
      logger.error(
        "Meeting transcription setup failed",
        { error: (err as Error).message },
        "meeting"
      );
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
    isProcessing,
    transcript,
    error,
    startTranscription,
    stopTranscription,
  };
}

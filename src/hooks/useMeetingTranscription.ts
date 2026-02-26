import { useState, useEffect, useRef, useCallback } from "react";
import logger from "../utils/logger";

interface UseMeetingTranscriptionReturn {
  isTranscribing: boolean;
  transcript: string;
  partialTranscript: string;
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
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ipcCleanupsRef = useRef<Array<() => void>>([]);
  const isTranscribingRef = useRef(false);
  const workletBlobUrlRef = useRef<string | null>(null);

  const cleanup = useCallback(async () => {
    ipcCleanupsRef.current.forEach((fn) => fn());
    ipcCleanupsRef.current = [];

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

    await window.electronAPI?.deepgramStreamingStop?.();
  }, []);

  const stopTranscription = useCallback(async () => {
    if (!isTranscribingRef.current) return;
    isTranscribingRef.current = false;
    setIsTranscribing(false);
    await cleanup();
    logger.info("Meeting transcription stopped", {}, "meeting");
  }, [cleanup]);

  const startTranscription = useCallback(async () => {
    if (isTranscribingRef.current) return;

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

      let chunkCount = 0;
      processor.port.onmessage = (event) => {
        if (!isTranscribingRef.current) return;
        chunkCount++;
        if (chunkCount <= 3 || chunkCount % 50 === 0) {
          logger.debug(
            "Audio chunk sent",
            { chunk: chunkCount, bytes: event.data.byteLength },
            "meeting"
          );
        }
        window.electronAPI?.deepgramStreamingSend?.(event.data);
      };

      source.connect(processor);

      const partialCleanup = window.electronAPI?.onDeepgramPartialTranscript?.((text) => {
        logger.debug(
          "Meeting partial transcript",
          { length: text.length, preview: text.slice(-80) },
          "meeting"
        );
        setPartialTranscript(text);
      });
      if (partialCleanup) ipcCleanupsRef.current.push(partialCleanup);

      const finalCleanup = window.electronAPI?.onDeepgramFinalTranscript?.((text) => {
        logger.info(
          "Meeting final transcript",
          { length: text.length, preview: text.slice(-80) },
          "meeting"
        );
        setTranscript(text);
        setPartialTranscript("");
      });
      if (finalCleanup) ipcCleanupsRef.current.push(finalCleanup);

      const result = await window.electronAPI?.deepgramStreamingStart?.({
        sampleRate: 16000,
        forceNew: true,
      });

      logger.info(
        "Deepgram streaming start result",
        { success: result?.success, error: result?.error },
        "meeting"
      );

      if (!result?.success) {
        logger.error(
          "Failed to start Deepgram streaming",
          { error: result?.error, code: result?.code },
          "meeting"
        );
        await cleanup();
        return;
      }

      isTranscribingRef.current = true;
      setIsTranscribing(true);
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
      if (isTranscribingRef.current) {
        isTranscribingRef.current = false;
        cleanup();
      }
    };
  }, [cleanup]);

  return {
    isTranscribing,
    transcript,
    partialTranscript,
    startTranscription,
    stopTranscription,
  };
}

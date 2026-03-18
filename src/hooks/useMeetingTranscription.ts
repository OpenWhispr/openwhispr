import { useState, useEffect, useRef, useCallback } from "react";
import { getSettings } from "../stores/settingsStore";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { getSystemAudioStream } from "../utils/systemAudio";
import logger from "../utils/logger";

export interface TranscriptSegment {
  id: string;
  text: string;
  source: "mic" | "system";
}

interface UseMeetingTranscriptionReturn {
  isRecording: boolean;
  transcript: string;
  partialTranscript: string;
  segments: TranscriptSegment[];
  micPartial: string;
  systemPartial: string;
  error: string | null;
  prepareTranscription: () => Promise<void>;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<void>;
}

const MEETING_AUDIO_BUFFER_SIZE = 800;
const MEETING_STOP_FLUSH_TIMEOUT_MS = 50;

const REALTIME_MODELS = new Set(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);

const getMeetingTranscriptionOptions = () => {
  const { cloudTranscriptionMode, cloudTranscriptionModel, openaiApiKey } = getSettings();
  const model = REALTIME_MODELS.has(cloudTranscriptionModel)
    ? cloudTranscriptionModel
    : "gpt-4o-mini-transcribe";
  const mode = cloudTranscriptionMode === "byok" && !!openaiApiKey ? "byok" : "openwhispr";
  return { provider: "openai-realtime" as const, model, mode };
};

const getMeetingWorkletBlobUrl = (() => {
  let blobUrl: string | null = null;

  return () => {
    if (blobUrl) return blobUrl;

    const code = `
const BUFFER_SIZE = ${MEETING_AUDIO_BUFFER_SIZE};
class MeetingPCMProcessor extends AudioWorkletProcessor {
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
registerProcessor("meeting-pcm-processor", MeetingPCMProcessor);
`;

    blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return blobUrl;
  };
})();

const getMeetingMicConstraints = async (): Promise<MediaStreamConstraints> => {
  const { preferBuiltInMic, selectedMicDeviceId } = getSettings();
  const micProcessing = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
  };

  if (preferBuiltInMic) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const builtInMic = devices.find(
        (device) => device.kind === "audioinput" && isBuiltInMicrophone(device.label)
      );

      if (builtInMic?.deviceId) {
        return {
          audio: {
            deviceId: { exact: builtInMic.deviceId },
            ...micProcessing,
          },
        };
      }
    } catch (err) {
      logger.debug(
        "Failed to enumerate microphones for meeting transcription",
        { error: (err as Error).message },
        "meeting"
      );
    }
  }

  if (selectedMicDeviceId && selectedMicDeviceId !== "default") {
    return {
      audio: {
        deviceId: { exact: selectedMicDeviceId },
        ...micProcessing,
      },
    };
  }

  return { audio: micProcessing };
};

const createAudioPipeline = async ({
  stream,
  context,
  label,
  onChunk,
}: {
  stream: MediaStream;
  context: AudioContext;
  label: string;
  onChunk: (chunk: ArrayBuffer) => void;
}) => {
  if (context.state === "suspended") {
    await context.resume();
  }

  await context.audioWorklet.addModule(getMeetingWorkletBlobUrl());

  const source = context.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(context, "meeting-pcm-processor");
  let chunkCount = 0;

  processor.port.onmessage = (event) => {
    const chunk = event.data;
    if (!(chunk instanceof ArrayBuffer)) return;

    if (chunkCount < 10 || chunkCount % 50 === 0) {
      const samples = new Int16Array(chunk);
      let maxAmplitude = 0;
      for (let i = 0; i < samples.length; i++) {
        const normalized = Math.abs(samples[i]) / 0x7fff;
        if (normalized > maxAmplitude) maxAmplitude = normalized;
      }

      logger.debug(
        `${label} audio chunk`,
        { maxAmplitude: maxAmplitude.toFixed(6), samples: samples.length },
        "meeting"
      );
    }

    chunkCount++;
    onChunk(chunk);
  };

  source.connect(processor);
  processor.connect(context.destination);

  return { source, processor };
};

/**
 * Detach an AudioContext from hardware output to avoid Bluetooth routing issues.
 * When BT headphones become the default output, the AudioContext can stall due to
 * HFP sample-rate mismatches. Using a "none" sink keeps processing running without
 * coupling to any physical device.
 */
const detachFromOutputDevice = async (ctx: AudioContext) => {
  if ("setSinkId" in ctx) {
    try {
      await (ctx as any).setSinkId({ type: "none" });
    } catch {}
  }
};

const flushAndDisconnectProcessor = async (processor: AudioWorkletNode | null) => {
  if (!processor) return;

  try {
    processor.port.postMessage("stop");
    await new Promise((resolve) => {
      window.setTimeout(resolve, MEETING_STOP_FLUSH_TIMEOUT_MS);
    });
  } catch {}

  processor.port.onmessage = null;
  processor.disconnect();
};

let segmentCounter = 0;

export function useMeetingTranscription(): UseMeetingTranscriptionReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [micPartial, setMicPartial] = useState("");
  const [systemPartial, setSystemPartial] = useState("");
  const [error, setError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micProcessorRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const isStartingRef = useRef(false);
  const isPreparedRef = useRef(false);
  const preparePromiseRef = useRef<Promise<void> | null>(null);
  const ipcCleanupsRef = useRef<Array<() => void>>([]);

  const cleanup = useCallback(async () => {
    const processors = [processorRef, micProcessorRef];
    const sources = [sourceRef, micSourceRef];
    const streams = [streamRef, micStreamRef];
    const contexts = [audioContextRef, micContextRef];

    for (const ref of processors) {
      await flushAndDisconnectProcessor(ref.current);
      ref.current = null;
    }
    for (const ref of sources) {
      ref.current?.disconnect();
      ref.current = null;
    }
    for (const ref of streams) {
      try {
        ref.current?.getTracks().forEach((t) => t.stop());
      } catch {}
      ref.current = null;
    }
    for (const ref of contexts) {
      try {
        await ref.current?.close();
      } catch {}
      ref.current = null;
    }

    ipcCleanupsRef.current.forEach((fn) => fn());
    ipcCleanupsRef.current = [];
    isPreparedRef.current = false;
  }, []);

  const stopTranscription = useCallback(async () => {
    if (!isRecordingRef.current) return;

    // Signal stop immediately so in-flight startTranscription can abort
    isRecordingRef.current = false;
    isStartingRef.current = false;
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

  const prepareTranscription = useCallback(async () => {
    if (isPreparedRef.current || isRecordingRef.current || isStartingRef.current) return;
    if (preparePromiseRef.current) return; // already preparing

    logger.info("Meeting transcription preparing (pre-warming WebSockets)...", {}, "meeting");

    const promise = (async () => {
      try {
        const result = await window.electronAPI?.meetingTranscriptionPrepare?.(
          getMeetingTranscriptionOptions()
        );

        if (result?.success) {
          isPreparedRef.current = true;
          logger.info(
            "Meeting transcription prepared",
            { alreadyPrepared: result.alreadyPrepared },
            "meeting"
          );
        } else {
          logger.error("Meeting transcription prepare failed", { error: result?.error }, "meeting");
        }
      } catch (err) {
        logger.error(
          "Meeting transcription prepare error",
          { error: (err as Error).message },
          "meeting"
        );
      } finally {
        preparePromiseRef.current = null;
      }
    })();

    preparePromiseRef.current = promise;
    await promise;
  }, []);

  const startTranscription = useCallback(async () => {
    if (isRecordingRef.current || isStartingRef.current) return;
    isStartingRef.current = true;

    logger.info("Meeting transcription starting...", {}, "meeting");
    setTranscript("");
    setPartialTranscript("");
    setSegments([]);
    setMicPartial("");
    setSystemPartial("");
    setError(null);

    // Set recording state immediately for instant UI feedback
    isRecordingRef.current = true;
    setIsRecording(true);

    // Wait for in-flight prepare to reuse the warm connection
    if (preparePromiseRef.current) {
      logger.debug("Waiting for in-flight prepare to finish...", {}, "meeting");
      await preparePromiseRef.current;
    }

    try {
      const startTime = performance.now();

      const [startResult, stream, micResult] = await Promise.all([
        window.electronAPI?.meetingTranscriptionStart?.(getMeetingTranscriptionOptions()),
        getSystemAudioStream(),
        getMeetingMicConstraints().then((constraints) =>
          navigator.mediaDevices.getUserMedia(constraints).catch((err) => {
            logger.error(
              "Mic capture failed, continuing with system audio only",
              { error: (err as Error).message },
              "meeting"
            );
            return null;
          })
        ),
      ]);

      const streamsMs = performance.now() - startTime;

      // Abort if stop was called during setup
      if (!isRecordingRef.current) {
        logger.info("Meeting transcription aborted during setup (stop called)", {}, "meeting");
        stream?.getTracks().forEach((t) => t.stop());
        micResult?.getTracks().forEach((t) => t.stop());
        isStartingRef.current = false;
        return;
      }

      if (!startResult?.success) {
        logger.error(
          "Meeting transcription IPC start failed",
          { error: startResult?.error },
          "meeting"
        );
        stream?.getTracks().forEach((track) => track.stop());
        micResult?.getTracks().forEach((track) => track.stop());
        isRecordingRef.current = false;
        isStartingRef.current = false;
        setIsRecording(false);
        return;
      }

      if (!stream) {
        logger.error("Could not capture system audio for meeting transcription", {}, "meeting");
        micResult?.getTracks().forEach((track) => track.stop());
        await window.electronAPI?.meetingTranscriptionStop?.();
        isRecordingRef.current = false;
        isStartingRef.current = false;
        setIsRecording(false);
        return;
      }
      streamRef.current = stream;

      const partialSetters = { mic: setMicPartial, system: setSystemPartial };

      const segmentCleanup = window.electronAPI?.onMeetingTranscriptionSegment?.(
        (data: { text: string; source: "mic" | "system"; type: "partial" | "final" }) => {
          const setPartialForSource = partialSetters[data.source];

          if (data.type === "partial") {
            setPartialForSource(data.text);
            setPartialTranscript(data.text);
          } else {
            setSegments((prev) => [
              ...prev,
              { id: `seg-${++segmentCounter}`, text: data.text, source: data.source },
            ]);
            setPartialForSource("");
            setTranscript((prev) => (prev ? prev + " " + data.text : data.text));
            setPartialTranscript("");
          }
        }
      );
      if (segmentCleanup) ipcCleanupsRef.current.push(segmentCleanup);

      const errorCleanup = window.electronAPI?.onMeetingTranscriptionError?.((err) => {
        setError(err);
        logger.error("Meeting transcription stream error", { error: err }, "meeting");
      });
      if (errorCleanup) ipcCleanupsRef.current.push(errorCleanup);

      const pendingSystemChunks: ArrayBuffer[] = [];
      const pendingMicChunks: ArrayBuffer[] = [];
      let socketReady = false;

      const audioContext = new AudioContext({ sampleRate: 24000 });
      await detachFromOutputDevice(audioContext);
      audioContextRef.current = audioContext;

      const systemPipelinePromise = createAudioPipeline({
        stream,
        context: audioContext,
        label: "Meeting system",
        onChunk: (chunk) => {
          if (!isRecordingRef.current) return;
          const samples = new Int16Array(chunk);
          let hasSignal = false;
          for (let i = 0; i < samples.length; i++) {
            if (samples[i] !== 0) {
              hasSignal = true;
              break;
            }
          }
          if (!hasSignal) return;
          if (socketReady) {
            window.electronAPI?.meetingTranscriptionSend?.(chunk, "system");
            return;
          }
          pendingSystemChunks.push(chunk.slice(0));
        },
      });

      let micPipelinePromise: Promise<void> | null = null;
      if (micResult) {
        micStreamRef.current = micResult;
        const micContext = new AudioContext({ sampleRate: 24000 });
        await detachFromOutputDevice(micContext);
        micContextRef.current = micContext;

        micPipelinePromise = createAudioPipeline({
          stream: micResult,
          context: micContext,
          label: "Meeting mic",
          onChunk: (chunk) => {
            if (!isRecordingRef.current) return;
            if (socketReady) {
              window.electronAPI?.meetingTranscriptionSend?.(chunk, "mic");
              return;
            }
            pendingMicChunks.push(chunk.slice(0));
          },
        }).then(({ source, processor }) => {
          micSourceRef.current = source;
          micProcessorRef.current = processor;

          const micTrack = micResult.getAudioTracks()[0];
          logger.info(
            "Mic capture started for meeting transcription",
            {
              label: micTrack?.label,
              settings: micTrack?.getSettings(),
            },
            "meeting"
          );
        });
      }

      const [systemPipeline] = await Promise.all(
        [systemPipelinePromise, micPipelinePromise].filter(Boolean)
      );

      if (systemPipeline) {
        sourceRef.current = systemPipeline.source;
        processorRef.current = systemPipeline.processor;
      }

      // Abort if stop was called during pipeline setup
      if (!isRecordingRef.current) {
        logger.info(
          "Meeting transcription aborted during pipeline setup (stop called)",
          {},
          "meeting"
        );
        isStartingRef.current = false;
        await cleanup();
        return;
      }

      isStartingRef.current = false;
      socketReady = true;

      for (const chunk of pendingSystemChunks) {
        window.electronAPI?.meetingTranscriptionSend?.(chunk, "system");
      }
      for (const chunk of pendingMicChunks) {
        window.electronAPI?.meetingTranscriptionSend?.(chunk, "mic");
      }

      const totalMs = performance.now() - startTime;
      logger.info(
        "Meeting transcription started successfully",
        {
          bufferedChunks: pendingSystemChunks.length + pendingMicChunks.length,
          streamsMs: Math.round(streamsMs),
          totalMs: Math.round(totalMs),
          wasPrepared: isPreparedRef.current,
        },
        "meeting"
      );
    } catch (err) {
      logger.error(
        "Meeting transcription setup failed",
        { error: (err as Error).message },
        "meeting"
      );
      isRecordingRef.current = false;
      isStartingRef.current = false;
      setIsRecording(false);
      await cleanup();
    }
  }, [cleanup]);

  useEffect(() => {
    getMeetingWorkletBlobUrl();
  }, []);

  useEffect(() => {
    return () => {
      // Don't reset isRecordingRef here — StrictMode double-mount would abort in-flight setup
      if (isRecordingRef.current) {
        void cleanup();
      }
    };
  }, [cleanup]);

  return {
    isRecording,
    transcript,
    partialTranscript,
    segments,
    micPartial,
    systemPartial,
    error,
    prepareTranscription,
    startTranscription,
    stopTranscription,
  };
}

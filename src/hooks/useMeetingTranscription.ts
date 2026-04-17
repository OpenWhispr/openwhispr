import { useState, useEffect, useRef, useCallback } from "react";
import { getSettings } from "../stores/settingsStore";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import type { SystemAudioAccessResult, SystemAudioStrategy } from "../types/electron";
import {
  DEFAULT_SYSTEM_AUDIO_ACCESS,
  getDisplayCaptureModeForStrategy,
  getFallbackSystemAudioAccess,
  isRendererSystemAudioStrategy,
} from "../utils/systemAudioAccess";
import logger from "../utils/logger";
import {
  lockTranscriptSpeaker,
  normalizeTranscriptSegment,
  type TranscriptSpeakerLockSource,
  type TranscriptSpeakerStatus,
} from "../utils/transcriptSpeakerState";

export interface TranscriptSegment {
  id: string;
  text: string;
  source: "mic" | "system";
  timestamp?: number;
  speaker?: string;
  speakerName?: string;
  speakerIsPlaceholder?: boolean;
  suggestedName?: string;
  suggestedProfileId?: number;
  speakerStatus?: TranscriptSpeakerStatus;
  speakerLocked?: boolean;
  speakerLockSource?: TranscriptSpeakerLockSource;
}

interface SpeakerIdentification {
  speakerId: string;
  displayName?: string | null;
  startTime: number;
  endTime: number;
}

interface RecentSystemSpeaker {
  speakerId: string;
  speakerName: string | null;
  speakerIsPlaceholder: boolean;
  updatedAt: number;
}

interface UseMeetingTranscriptionReturn {
  isRecording: boolean;
  transcript: string;
  partialTranscript: string;
  segments: TranscriptSegment[];
  micPartial: string;
  systemPartial: string;
  systemPartialSpeakerId: string | null;
  systemPartialSpeakerName: string | null;
  error: string | null;
  diarizationSessionId: string | null;
  prepareTranscription: () => Promise<void>;
  startTranscription: (_options?: {
    seedSegments?: TranscriptSegment[];
    noteId?: number | null;
  }) => Promise<void>;
  stopTranscription: () => Promise<void>;
  lockSpeaker: (speakerId: string, displayName: string) => void;
}

const MEETING_AUDIO_BUFFER_SIZE = 800;
const MEETING_STOP_FLUSH_TIMEOUT_MS = 50;
const MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

const REALTIME_MODELS = new Set(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);
const SPEAKER_IDENTIFICATION_RETENTION_MS = 30_000;
const SYSTEM_SPEAKER_CARRY_FORWARD_MS = 8_000;
const buildTranscriptText = (segments: TranscriptSegment[]) =>
  segments
    .map((segment) => segment.text)
    .join(" ")
    .trim();

const getSpeakerNumericIndex = (speakerId?: string): number | null => {
  if (!speakerId) {
    return null;
  }

  const match = speakerId.match(/speaker_(\d+)/);
  return match ? Number(match[1]) : null;
};

const isSegmentWithinIdentificationWindow = (
  segment: TranscriptSegment,
  identification: SpeakerIdentification
) => {
  if (segment.source !== "system" || segment.timestamp == null) {
    return false;
  }

  return (
    segment.timestamp >= identification.startTime && segment.timestamp <= identification.endTime
  );
};

const getMeetingTranscriptionOptions = () => {
  const {
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    cloudTranscriptionMode,
    cloudTranscriptionModel,
    cloudTranscriptionProvider,
    openaiApiKey,
  } = getSettings();

  if (useLocalWhisper) {
    return {
      provider: "local" as const,
      localProvider: localTranscriptionProvider,
      localModel:
        localTranscriptionProvider === "nvidia"
          ? parakeetModel || "parakeet-tdt-0.6b-v3"
          : whisperModel || "base",
    };
  }

  if (cloudTranscriptionProvider === "gladia") {
    return { provider: "gladia-async" as const };
  }

  const model = REALTIME_MODELS.has(cloudTranscriptionModel)
    ? cloudTranscriptionModel
    : "gpt-4o-mini-transcribe";
  const mode = cloudTranscriptionMode === "byok" && !!openaiApiKey ? "byok" : "openwhispr";
  return { provider: "openai-realtime" as const, model, mode };
};

const stopMediaStream = (stream: MediaStream | null) => {
  try {
    stream?.getTracks().forEach((track) => track.stop());
  } catch {}
};

const getDisplayCaptureOptions = (mode: "loopback" | "portal") => {
  if (mode === "loopback") {
    return { video: true, audio: true };
  }

  return {
    video: true,
    audio: true,
    systemAudio: "include",
    windowAudio: "system",
    selfBrowserSurface: "exclude",
  } as DisplayMediaStreamOptions & {
    systemAudio?: "include";
    windowAudio?: "system";
    selfBrowserSurface?: "exclude";
  };
};

const requestSystemAudioDisplayStream = async (mode: "loopback" | "portal") => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(getDisplayCaptureOptions(mode));
    const audioTrack = stream.getAudioTracks()[0];

    if (!audioTrack) {
      stopMediaStream(stream);
      return { stream: null, error: new Error("No system-audio track was returned.") };
    }

    stream.getVideoTracks().forEach((track) => track.stop());
    return { stream, error: null };
  } catch (error) {
    return { stream: null, error: error as Error };
  }
};

const prepareMeetingSystemAudioCapture = (initialSystemAudioAccess: SystemAudioAccessResult) => {
  const initialSystemAudioStrategy = initialSystemAudioAccess.strategy ?? "unsupported";
  const initialDisplayCaptureStrategy = isRendererSystemAudioStrategy(initialSystemAudioStrategy)
    ? initialSystemAudioStrategy
    : null;
  const systemCapturePromise = initialDisplayCaptureStrategy
    ? requestSystemAudioDisplayStream(
        getDisplayCaptureModeForStrategy(initialDisplayCaptureStrategy)
      )
    : Promise.resolve({ stream: null, error: null });

  return {
    initialSystemAudioStrategy,
    initialDisplayCaptureStrategy,
    systemCapturePromise,
  };
};

const ensureRendererSystemAudioCapture = async ({
  initialDisplayCaptureStrategy,
  systemAudioStrategy,
  systemCaptureResult,
}: {
  initialDisplayCaptureStrategy: "loopback" | "browser-portal" | null;
  systemAudioStrategy: SystemAudioStrategy;
  systemCaptureResult: { stream: MediaStream | null; error: Error | null };
}) => {
  if (
    systemCaptureResult.stream ||
    systemCaptureResult.error ||
    !isRendererSystemAudioStrategy(systemAudioStrategy) ||
    initialDisplayCaptureStrategy
  ) {
    return systemCaptureResult;
  }

  return requestSystemAudioDisplayStream(getDisplayCaptureModeForStrategy(systemAudioStrategy));
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
            ...MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
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
        ...MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
      },
    };
  }

  return { audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS };
};

const createAudioPipeline = async ({
  stream,
  context,
  onChunk,
}: {
  stream: MediaStream;
  context: AudioContext;
  onChunk: (chunk: ArrayBuffer) => void;
}) => {
  if (context.state === "suspended") {
    await context.resume();
  }

  await context.audioWorklet.addModule(getMeetingWorkletBlobUrl());

  const source = context.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(context, "meeting-pcm-processor");
  const silentGain = context.createGain();
  silentGain.gain.value = 0;

  processor.port.onmessage = (event) => {
    const chunk = event.data;
    if (!(chunk instanceof ArrayBuffer)) return;
    onChunk(chunk);
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);

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
  const [systemPartialSpeakerId, setSystemPartialSpeakerId] = useState<string | null>(null);
  const [systemPartialSpeakerName, setSystemPartialSpeakerName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diarizationSessionId, setDiarizationSessionId] = useState<string | null>(null);

  const micContextRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micProcessorRef = useRef<AudioWorkletNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const systemContextRef = useRef<AudioContext | null>(null);
  const systemSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const systemProcessorRef = useRef<AudioWorkletNode | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const isStartingRef = useRef(false);
  const isPreparedRef = useRef(false);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const preparePromiseRef = useRef<Promise<void> | null>(null);
  const ipcCleanupsRef = useRef<Array<() => void>>([]);
  const pendingCleanupRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakerIdentificationsRef = useRef<SpeakerIdentification[]>([]);
  const nextPlaceholderSpeakerIndexRef = useRef(0);
  const systemPartialSpeakerIdRef = useRef<string | null>(null);
  const recentSystemSpeakerRef = useRef<RecentSystemSpeaker | null>(null);
  const speakerLocksRef = useRef<Map<string, string>>(new Map());

  const setSystemPartialSpeakerIdentity = useCallback(
    (speakerId: string | null, speakerName: string | null) => {
      systemPartialSpeakerIdRef.current = speakerId;
      setSystemPartialSpeakerId(speakerId);
      setSystemPartialSpeakerName(speakerName);
    },
    []
  );

  const applySpeakerIdentification = useCallback(
    (segment: TranscriptSegment, identification: SpeakerIdentification): TranscriptSegment => {
      if (
        segment.source !== "system" ||
        !isSegmentWithinIdentificationWindow(segment, identification) ||
        (segment.speaker &&
          !segment.speakerIsPlaceholder &&
          segment.speakerStatus !== "provisional") ||
        segment.speakerLocked
      ) {
        return segment;
      }

      return normalizeTranscriptSegment({
        ...segment,
        speaker: identification.speakerId,
        speakerName: identification.displayName ?? segment.speakerName,
        speakerIsPlaceholder: false,
        speakerStatus: "confirmed",
      });
    },
    []
  );

  const rememberSystemSpeaker = useCallback(
    (
      speakerId: string | null,
      speakerName: string | null,
      speakerIsPlaceholder: boolean,
      updatedAt = Date.now()
    ) => {
      recentSystemSpeakerRef.current = speakerId
        ? {
            speakerId,
            speakerName,
            speakerIsPlaceholder,
            updatedAt,
          }
        : null;
    },
    []
  );

  const getRecentSystemSpeaker = useCallback((nowMs: number) => {
    const candidate = recentSystemSpeakerRef.current;
    if (!candidate) {
      return null;
    }

    return nowMs - candidate.updatedAt <= SYSTEM_SPEAKER_CARRY_FORWARD_MS ? candidate : null;
  }, []);

  const reserveSpeakerIndex = useCallback((speakerId?: string) => {
    const idx = getSpeakerNumericIndex(speakerId);
    if (idx == null) {
      return;
    }

    nextPlaceholderSpeakerIndexRef.current = Math.max(
      nextPlaceholderSpeakerIndexRef.current,
      idx + 1
    );
  }, []);

  const assignProvisionalSpeaker = useCallback(
    (segment: TranscriptSegment) => {
      if (segment.source !== "system" || segment.speaker) {
        return segment;
      }

      const nowMs = segment.timestamp ?? Date.now();
      const partialSpeakerId = systemPartialSpeakerIdRef.current;
      if (partialSpeakerId) {
        reserveSpeakerIndex(partialSpeakerId);
        return normalizeTranscriptSegment({
          ...segment,
          speaker: partialSpeakerId,
          speakerIsPlaceholder: true,
          speakerStatus: "provisional",
        });
      }

      const recentSystemSpeaker = getRecentSystemSpeaker(nowMs);
      if (recentSystemSpeaker?.speakerId) {
        reserveSpeakerIndex(recentSystemSpeaker.speakerId);
        return normalizeTranscriptSegment({
          ...segment,
          speaker: recentSystemSpeaker.speakerId,
          speakerName: recentSystemSpeaker.speakerName ?? undefined,
          speakerIsPlaceholder: recentSystemSpeaker.speakerIsPlaceholder,
          speakerStatus: "provisional",
        });
      }

      const previousSystemSegment = [...segmentsRef.current]
        .reverse()
        .find(
          (candidate) =>
            candidate.source === "system" &&
            candidate.speaker &&
            candidate.timestamp != null &&
            nowMs - candidate.timestamp <= SYSTEM_SPEAKER_CARRY_FORWARD_MS
        );

      if (previousSystemSegment?.speaker) {
        reserveSpeakerIndex(previousSystemSegment.speaker);
        return normalizeTranscriptSegment({
          ...segment,
          speaker: previousSystemSegment.speaker,
          speakerName: previousSystemSegment.speakerName,
          speakerIsPlaceholder: true,
          speakerStatus: "provisional",
        });
      }

      const speakerId = `speaker_${nextPlaceholderSpeakerIndexRef.current}`;
      nextPlaceholderSpeakerIndexRef.current += 1;

      return normalizeTranscriptSegment({
        ...segment,
        speaker: speakerId,
        speakerIsPlaceholder: true,
        speakerStatus: "provisional",
      });
    },
    [getRecentSystemSpeaker, reserveSpeakerIndex]
  );

  const cleanup = useCallback(async () => {
    await flushAndDisconnectProcessor(micProcessorRef.current);
    micProcessorRef.current = null;

    micSourceRef.current?.disconnect();
    micSourceRef.current = null;

    try {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    micStreamRef.current = null;

    try {
      await micContextRef.current?.close();
    } catch {}
    micContextRef.current = null;

    await flushAndDisconnectProcessor(systemProcessorRef.current);
    systemProcessorRef.current = null;

    systemSourceRef.current?.disconnect();
    systemSourceRef.current = null;

    stopMediaStream(systemStreamRef.current);
    systemStreamRef.current = null;

    try {
      await systemContextRef.current?.close();
    } catch {}
    systemContextRef.current = null;

    ipcCleanupsRef.current.forEach((fn) => fn());
    ipcCleanupsRef.current = [];
    isPreparedRef.current = false;
    isRecordingRef.current = false;
    isStartingRef.current = false;
  }, []);

  const stopTranscription = useCallback(async () => {
    if (!isRecordingRef.current) return;

    isRecordingRef.current = false;
    isStartingRef.current = false;
    setIsRecording(false);

    await cleanup();

    try {
      const result = await window.electronAPI?.meetingTranscriptionStop?.();
      if (result?.diarizationSessionId) {
        setDiarizationSessionId(result.diarizationSessionId);
      }
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
    if (preparePromiseRef.current) return;

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

  const startTranscription = useCallback(
    async (_options?: { seedSegments?: TranscriptSegment[]; noteId?: number | null }) => {
      if (isRecordingRef.current || isStartingRef.current) return;
      isStartingRef.current = true;
      const systemAudioAccessPromise =
        window.electronAPI?.checkSystemAudioAccess?.() ??
        Promise.resolve(DEFAULT_SYSTEM_AUDIO_ACCESS);

      logger.info("Meeting transcription starting...", {}, "meeting");
      const seed = _options?.seedSegments ?? [];
      const locks = new Map<string, string>();
      let maxSpeakerIndex = -1;
      for (const s of seed) {
        const idx = getSpeakerNumericIndex(s.speaker);
        if (idx != null && idx > maxSpeakerIndex) maxSpeakerIndex = idx;
        if (s.speakerLocked && s.speaker && s.speakerName) {
          locks.set(s.speaker, s.speakerName);
        }
      }
      setTranscript(buildTranscriptText(seed));
      setPartialTranscript("");
      setSegments(seed);
      segmentsRef.current = seed;
      setMicPartial("");
      setSystemPartial("");
      setSystemPartialSpeakerIdentity(null, null);
      setError(null);
      speakerIdentificationsRef.current = [];
      nextPlaceholderSpeakerIndexRef.current = maxSpeakerIndex + 1;
      recentSystemSpeakerRef.current = null;
      speakerLocksRef.current = locks;

      isRecordingRef.current = true;
      setIsRecording(true);

      if (preparePromiseRef.current) {
        logger.debug("Waiting for in-flight prepare to finish...", {}, "meeting");
        await preparePromiseRef.current;
      }

      try {
        const startTime = performance.now();
        const initialSystemAudioAccess =
          (await systemAudioAccessPromise) ?? getFallbackSystemAudioAccess();
        const { initialSystemAudioStrategy, initialDisplayCaptureStrategy, systemCapturePromise } =
          prepareMeetingSystemAudioCapture(initialSystemAudioAccess);

        const [startResult, micResult, initialSystemCaptureResult] = await Promise.all([
          window.electronAPI?.meetingTranscriptionStart?.({
            ...getMeetingTranscriptionOptions(),
            noteId: _options?.noteId ?? null,
          }),
          getMeetingMicConstraints().then(async (constraints) => {
            try {
              return await navigator.mediaDevices.getUserMedia(constraints);
            } catch (err) {
              const hasExactDevice =
                typeof constraints.audio === "object" &&
                constraints.audio !== null &&
                "deviceId" in constraints.audio;
              if (hasExactDevice) {
                try {
                  const fallbackStream = await navigator.mediaDevices.getUserMedia({
                    audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
                  });
                  logger.info(
                    "Meeting mic capture recovered using default device",
                    { error: (err as Error).message },
                    "meeting"
                  );
                  return fallbackStream;
                } catch (fallbackErr) {
                  logger.error(
                    "Meeting mic capture failed, continuing with system audio only",
                    { error: (fallbackErr as Error).message },
                    "meeting"
                  );
                  return null;
                }
              }
              logger.error(
                "Meeting mic capture failed, continuing with system audio only",
                { error: (err as Error).message, constraints },
                "meeting"
              );
              return null;
            }
          }),
          systemCapturePromise,
        ]);
        let systemCaptureResult = initialSystemCaptureResult;

        const streamsMs = performance.now() - startTime;
        if (!isRecordingRef.current) {
          logger.info("Meeting transcription aborted during setup (stop called)", {}, "meeting");
          stopMediaStream(micResult);
          stopMediaStream(systemCaptureResult.stream);
          isStartingRef.current = false;
          return;
        }

        if (!startResult?.success) {
          logger.error(
            "Meeting transcription IPC start failed",
            { error: startResult?.error },
            "meeting"
          );
          setError(startResult?.error || "Failed to start meeting transcription");
          stopMediaStream(micResult);
          stopMediaStream(systemCaptureResult.stream);
          isRecordingRef.current = false;
          isStartingRef.current = false;
          setIsRecording(false);
          return;
        }

        const systemAudioMode = startResult.systemAudioMode || initialSystemAudioAccess.mode;
        const systemAudioStrategy = startResult.systemAudioStrategy || initialSystemAudioStrategy;
        systemCaptureResult = await ensureRendererSystemAudioCapture({
          initialDisplayCaptureStrategy,
          systemAudioStrategy,
          systemCaptureResult,
        });
        const systemAudioHandledInMain =
          systemAudioMode !== "unsupported" && !isRendererSystemAudioStrategy(systemAudioStrategy);
        const systemCaptureError = systemAudioHandledInMain ? null : systemCaptureResult.error;

        if (!micResult && (systemAudioHandledInMain || systemCaptureResult.stream)) {
          setError("Microphone capture failed. Continuing with system audio only.");
        }

        if (!micResult && !systemCaptureResult.stream && !systemAudioHandledInMain) {
          logger.error("Meeting transcription has no available audio source", {}, "meeting");
          setError(
            systemAudioMode === "unsupported"
              ? "No microphone is available and system audio capture is unsupported on this device."
              : systemCaptureError?.message ||
                  "No microphone is available and system audio capture could not be started."
          );
          await window.electronAPI?.meetingTranscriptionStop?.();
          isRecordingRef.current = false;
          isStartingRef.current = false;
          setIsRecording(false);
          return;
        }

        const partialSetters = { mic: setMicPartial, system: setSystemPartial };

        const segmentCleanup = window.electronAPI?.onMeetingTranscriptionSegment?.(
          (data: {
            text: string;
            source: "mic" | "system";
            type: "partial" | "final" | "retract";
            timestamp?: number;
          }) => {
            const setPartialForSource = partialSetters[data.source];

            if (data.type === "retract") {
              setSegments((prev) => {
                const next = prev.filter(
                  (seg) =>
                    !(
                      seg.source === data.source &&
                      seg.timestamp === data.timestamp &&
                      seg.text === data.text
                    )
                );
                segmentsRef.current = next;
                setTranscript(buildTranscriptText(next));
                return next;
              });
              return;
            }

            if (data.type === "partial") {
              setPartialForSource(data.text);
              setPartialTranscript(data.text);
              if (data.source === "system" && !systemPartialSpeakerIdRef.current) {
                const speakerId = `speaker_${nextPlaceholderSpeakerIndexRef.current}`;
                nextPlaceholderSpeakerIndexRef.current += 1;
                setSystemPartialSpeakerIdentity(speakerId, null);
              }
            } else {
              let rawSegment: TranscriptSegment = normalizeTranscriptSegment({
                id: `seg-${++segmentCounter}`,
                text: data.text,
                source: data.source,
                timestamp: data.timestamp,
              });

              for (let i = speakerIdentificationsRef.current.length - 1; i >= 0; i -= 1) {
                rawSegment = applySpeakerIdentification(
                  rawSegment,
                  speakerIdentificationsRef.current[i]
                );
              }

              const provisional = assignProvisionalSpeaker(rawSegment);
              reserveSpeakerIndex(provisional.speaker);
              const lockedName = provisional.speaker
                ? speakerLocksRef.current.get(provisional.speaker)
                : undefined;
              const seg = lockedName
                ? lockTranscriptSpeaker(provisional, {
                    speakerName: lockedName,
                    speakerIsPlaceholder: false,
                    suggestedName: undefined,
                    suggestedProfileId: undefined,
                  })
                : provisional;
              setSegments((prev) => {
                const ts = seg.timestamp ?? Infinity;
                let i = prev.length;
                while (i > 0 && (prev[i - 1].timestamp ?? 0) > ts) i--;
                const next =
                  i === prev.length ? [...prev, seg] : [...prev.slice(0, i), seg, ...prev.slice(i)];
                segmentsRef.current = next;
                setTranscript(buildTranscriptText(next));
                return next;
              });
              if (data.source === "system" && seg.speaker) {
                rememberSystemSpeaker(
                  seg.speaker,
                  seg.speakerName ?? null,
                  !!seg.speakerIsPlaceholder,
                  seg.timestamp ?? Date.now()
                );
              }
              setPartialForSource("");
              if (data.source === "system") {
                setSystemPartialSpeakerIdentity(null, null);
              }
              setPartialTranscript("");
            }
          }
        );
        if (segmentCleanup) ipcCleanupsRef.current.push(segmentCleanup);

        const speakerCleanup = window.electronAPI?.onMeetingSpeakerIdentified?.((data) => {
          reserveSpeakerIndex(data.speakerId);
          setSystemPartialSpeakerIdentity(data.speakerId, data.displayName ?? null);
          rememberSystemSpeaker(data.speakerId, data.displayName ?? null, false, data.endTime);
          speakerIdentificationsRef.current = [
            ...speakerIdentificationsRef.current.filter(
              (id) => id.endTime >= data.endTime - SPEAKER_IDENTIFICATION_RETENTION_MS
            ),
            data,
          ];
          setSegments((prev) => {
            const next = prev.map((segment) => applySpeakerIdentification(segment, data));
            segmentsRef.current = next;
            return next;
          });
        });
        if (speakerCleanup) ipcCleanupsRef.current.push(speakerCleanup);

        const mergeCleanup = window.electronAPI?.onMeetingSpeakersMerged?.((merges) => {
          setSegments((prev) => {
            let next = prev;
            for (const { keep, remove, displayName } of merges) {
              next = next.map((seg) => {
                if (seg.speaker !== remove || seg.speakerLocked) return seg;
                return normalizeTranscriptSegment({
                  ...seg,
                  speaker: keep,
                  speakerName: displayName ?? seg.speakerName,
                });
              });
            }
            segmentsRef.current = next;
            return next;
          });

          for (const { keep, remove, displayName } of merges) {
            if (recentSystemSpeakerRef.current?.speakerId === remove) {
              recentSystemSpeakerRef.current.speakerId = keep;
              if (displayName) recentSystemSpeakerRef.current.speakerName = displayName;
            }

            for (const id of speakerIdentificationsRef.current) {
              if (id.speakerId === remove) id.speakerId = keep;
            }

            const lockedName = speakerLocksRef.current.get(remove);
            if (lockedName) {
              speakerLocksRef.current.set(keep, lockedName);
              speakerLocksRef.current.delete(remove);
            }
          }
        });
        if (mergeCleanup) ipcCleanupsRef.current.push(mergeCleanup);

        const errorCleanup = window.electronAPI?.onMeetingTranscriptionError?.((err) => {
          setError(err);
          logger.error("Meeting transcription stream error", { error: err }, "meeting");
        });
        if (errorCleanup) ipcCleanupsRef.current.push(errorCleanup);

        if (startResult.oneOnOneAttendee) {
          const synthetic: SpeakerIdentification = {
            speakerId: "speaker_0",
            displayName: startResult.oneOnOneAttendee.displayName,
            startTime: 0,
            endTime: Number.MAX_SAFE_INTEGER,
          };
          reserveSpeakerIndex(synthetic.speakerId);
          setSystemPartialSpeakerIdentity(synthetic.speakerId, synthetic.displayName);
          rememberSystemSpeaker(synthetic.speakerId, synthetic.displayName, false, Date.now());
          speakerIdentificationsRef.current.push(synthetic);
        }

        const pendingMicChunks: ArrayBuffer[] = [];
        const pendingSystemChunks: ArrayBuffer[] = [];
        let socketReady = false;

        let micPipelinePromise: Promise<void> | null = null;
        if (micResult) {
          micStreamRef.current = micResult;
          const micContext = new AudioContext({ sampleRate: 24000 });
          await detachFromOutputDevice(micContext);
          micContextRef.current = micContext;

          micPipelinePromise = createAudioPipeline({
            stream: micResult,
            context: micContext,
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

        if (micPipelinePromise) {
          await micPipelinePromise;
        }

        if (systemCaptureResult.stream) {
          const systemStream = systemCaptureResult.stream;
          systemStreamRef.current = systemStream;

          const systemContext = new AudioContext({ sampleRate: 24000 });
          await detachFromOutputDevice(systemContext);
          systemContextRef.current = systemContext;

          await createAudioPipeline({
            stream: systemStream,
            context: systemContext,
            onChunk: (chunk) => {
              if (!isRecordingRef.current) return;
              if (socketReady) {
                window.electronAPI?.meetingTranscriptionSend?.(chunk, "system");
                return;
              }
              pendingSystemChunks.push(chunk.slice(0));
            },
          }).then(({ source, processor }) => {
            systemSourceRef.current = source;
            systemProcessorRef.current = processor;
          });
        } else if (systemCaptureError) {
          if (systemAudioStrategy === "browser-portal") {
            logger.warn(
              "Linux system audio capture failed, continuing with mic only",
              { error: systemCaptureError.message },
              "meeting"
            );
          } else if (systemAudioStrategy === "loopback") {
            logger.warn(
              "System audio loopback failed, continuing with mic only",
              { error: systemCaptureError.message },
              "meeting"
            );
          }
        }

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

        for (const chunk of pendingMicChunks) {
          window.electronAPI?.meetingTranscriptionSend?.(chunk, "mic");
        }
        for (const chunk of pendingSystemChunks) {
          window.electronAPI?.meetingTranscriptionSend?.(chunk, "system");
        }

        const totalMs = performance.now() - startTime;
        logger.info(
          "Meeting transcription started successfully",
          {
            systemAudioMode,
            systemAudioStrategy,
            bufferedChunks: pendingMicChunks.length,
            bufferedSystemChunks: pendingSystemChunks.length,
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
        setError((err as Error).message);
        isRecordingRef.current = false;
        isStartingRef.current = false;
        setIsRecording(false);
        await cleanup();
      }
    },
    [
      applySpeakerIdentification,
      assignProvisionalSpeaker,
      cleanup,
      rememberSystemSpeaker,
      reserveSpeakerIndex,
      setSystemPartialSpeakerIdentity,
    ]
  );

  const lockSpeaker = useCallback(
    (speakerId: string, displayName: string) => {
      if (!speakerId || !displayName) return;
      speakerLocksRef.current.set(speakerId, displayName);
      setSegments((prev) => {
        const next = prev.map((s) =>
          s.speaker === speakerId
            ? lockTranscriptSpeaker(s, {
                speakerName: displayName,
                speakerIsPlaceholder: false,
                suggestedName: undefined,
                suggestedProfileId: undefined,
              })
            : s
        );
        segmentsRef.current = next;
        return next;
      });
      const recent = recentSystemSpeakerRef.current;
      if (recent?.speakerId === speakerId) {
        recentSystemSpeakerRef.current = {
          ...recent,
          speakerName: displayName,
          speakerIsPlaceholder: false,
        };
      }
      if (systemPartialSpeakerIdRef.current === speakerId) {
        setSystemPartialSpeakerIdentity(speakerId, displayName);
      }
    },
    [setSystemPartialSpeakerIdentity]
  );

  useEffect(() => {
    getMeetingWorkletBlobUrl();
  }, []);

  useEffect(() => {
    if (pendingCleanupRef.current) {
      clearTimeout(pendingCleanupRef.current);
      pendingCleanupRef.current = null;
    }

    return () => {
      pendingCleanupRef.current = setTimeout(() => {
        pendingCleanupRef.current = null;
        void cleanup();
      }, 0);
    };
  }, [cleanup]);

  return {
    isRecording,
    transcript,
    partialTranscript,
    segments,
    micPartial,
    systemPartial,
    systemPartialSpeakerId,
    systemPartialSpeakerName,
    error,
    diarizationSessionId,
    prepareTranscription,
    startTranscription,
    stopTranscription,
    lockSpeaker,
  };
}

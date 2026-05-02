import { create } from "zustand";
import { getSettings, selectResolvedMeetingTranscription } from "./settingsStore";
import { useStreamingProvidersStore } from "./streamingProvidersStore";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import type { SystemAudioAccessResult, SystemAudioStrategy } from "../types/electron";
import {
  DEFAULT_SYSTEM_AUDIO_ACCESS,
  getDisplayCaptureModeForStrategy,
  getFallbackSystemAudioAccess,
  isRendererSystemAudioStrategy,
} from "../utils/systemAudioAccess";
import {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
} from "../constants/speakerDetection.json";
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

export const SIDE_PANEL_BREAKPOINT_PX = 1024;

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

interface MeetingRecordingState {
  isRecording: boolean;
  isTranscribing: boolean;
  recordingNoteId: number | null;
  recordingNoteTitle: string | null;
  recordingFolderId: number | null;
  segments: TranscriptSegment[];
  transcript: string;
  micPartial: string;
  systemPartial: string;
  systemPartialSpeakerId: string | null;
  systemPartialSpeakerName: string | null;
  diarizationSessionId: string | null;
  sessionDiarizationEnabled: boolean;
  sessionExpectedCount: number;
  userTouchedStepper: boolean;
  error: string | null;
  currentMicLevel: number;
  windowWidth: number;
}

const MEETING_AUDIO_BUFFER_SIZE = 800;
const MEETING_STOP_FLUSH_TIMEOUT_MS = 50;
const MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

const SPEAKER_IDENTIFICATION_RETENTION_MS = 30_000;
const SYSTEM_SPEAKER_CARRY_FORWARD_MS = 8_000;

const buildTranscriptText = (segments: TranscriptSegment[]) =>
  segments
    .map((segment) => segment.text)
    .join(" ")
    .trim();

const getSpeakerNumericIndex = (speakerId?: string): number | null => {
  if (!speakerId) return null;
  const match = speakerId.match(/speaker_(\d+)/);
  return match ? Number(match[1]) : null;
};

const isSegmentWithinIdentificationWindow = (
  segment: TranscriptSegment,
  identification: SpeakerIdentification
) => {
  if (segment.source !== "system" || segment.timestamp == null) return false;
  return (
    segment.timestamp >= identification.startTime && segment.timestamp <= identification.endTime
  );
};

const getMeetingTranscriptionOptions = () => {
  const state = getSettings();
  const resolved = selectResolvedMeetingTranscription(state);

  if (resolved.useLocalWhisper) {
    return {
      provider: "local" as const,
      localProvider: resolved.localTranscriptionProvider,
      localModel:
        resolved.localTranscriptionProvider === "nvidia"
          ? resolved.parakeetModel || "parakeet-tdt-0.6b-v3"
          : resolved.whisperModel || "base",
    };
  }

  const catalog = useStreamingProvidersStore.getState().providers;
  const provider =
    catalog?.find((p) => p.id === resolved.cloudTranscriptionProvider) ?? catalog?.[0];
  const byokKeyAvailable = provider?.id === "openai" ? !!state.openaiApiKey : true;
  const mode =
    resolved.cloudTranscriptionMode === "byok" && byokKeyAvailable ? "byok" : "openwhispr";
  if (!provider) {
    logger.debug(
      "Streaming providers catalog not loaded, falling back to OpenAI default",
      {},
      "meeting"
    );
    return { provider: "openai-realtime" as const, model: "gpt-4o-mini-transcribe", mode };
  }
  const model =
    provider.models.find((m) => m.id === resolved.cloudTranscriptionModel)?.id ??
    provider.models.find((m) => m.default)?.id ??
    provider.models[0]?.id;
  return { provider: `${provider.id}-realtime` as const, model, mode };
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

export const primeMeetingWorklet = () => {
  getMeetingWorkletBlobUrl();
};

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

// Detach an AudioContext from hardware output to avoid Bluetooth routing issues.
// When BT headphones become the default output, the AudioContext can stall due to
// HFP sample-rate mismatches. Using a "none" sink keeps processing running without
// coupling to any physical device.
const detachFromOutputDevice = async (ctx: AudioContext) => {
  if ("setSinkId" in ctx) {
    try {
      await (ctx as unknown as { setSinkId: (cfg: { type: string }) => Promise<void> }).setSinkId({
        type: "none",
      });
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

// Module-scoped pipeline state. The audio nodes/streams are stored here (not on
// React refs) because the audio pipeline outlives any single React component:
// the same pipeline must survive view changes / re-mounts of the consumer view.
let micContext: AudioContext | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let micProcessor: AudioWorkletNode | null = null;
let micStream: MediaStream | null = null;
let micAnalyser: AnalyserNode | null = null;
let systemContext: AudioContext | null = null;
let systemSource: MediaStreamAudioSourceNode | null = null;
let systemProcessor: AudioWorkletNode | null = null;
let systemStream: MediaStream | null = null;
let isRecordingFlag = false;
let isStartingFlag = false;
let isPrepared = false;
let segmentsRefValue: TranscriptSegment[] = [];
let preparePromise: Promise<void> | null = null;
let ipcCleanups: Array<() => void> = [];
let speakerIdentifications: SpeakerIdentification[] = [];
let nextPlaceholderSpeakerIndex = 0;
let systemPartialSpeakerIdValue: string | null = null;
let recentSystemSpeaker: RecentSystemSpeaker | null = null;
let speakerLocks: Map<string, string> = new Map();
let pushConfigTimeout: ReturnType<typeof setTimeout> | null = null;

export const useMeetingRecordingStore = create<MeetingRecordingState>()(() => ({
  isRecording: false,
  isTranscribing: false,
  recordingNoteId: null,
  recordingNoteTitle: null,
  recordingFolderId: null,
  segments: [],
  transcript: "",
  micPartial: "",
  systemPartial: "",
  systemPartialSpeakerId: null,
  systemPartialSpeakerName: null,
  diarizationSessionId: null,
  sessionDiarizationEnabled:
    (getSettings() as { speakerDiarizationEnabled?: boolean }).speakerDiarizationEnabled ?? true,
  sessionExpectedCount: DEFAULT_EXPECTED_SPEAKER_COUNT,
  userTouchedStepper: false,
  error: null,
  currentMicLevel: 0,
  windowWidth: typeof window !== "undefined" ? window.innerWidth : SIDE_PANEL_BREAKPOINT_PX,
}));

export const getMicAnalyser = (): AnalyserNode | null => micAnalyser;

function pushConfig(enabled: boolean, expectedCount: number) {
  if (pushConfigTimeout) clearTimeout(pushConfigTimeout);
  pushConfigTimeout = setTimeout(() => {
    (
      window.electronAPI as unknown as {
        setMeetingSessionSpeakerConfig?: (config: {
          enabled: boolean;
          expectedCount: number;
        }) => void;
      }
    )?.setMeetingSessionSpeakerConfig?.({ enabled, expectedCount });
  }, 150);
}

export function setSessionDiarizationEnabled(enabled: boolean): void {
  useMeetingRecordingStore.setState({ sessionDiarizationEnabled: enabled });
  pushConfig(enabled, useMeetingRecordingStore.getState().sessionExpectedCount);
}

export function setSessionExpectedCount(count: number): void {
  const clamped = Math.max(1, Math.min(MAX_SPEAKER_COUNT, count));
  useMeetingRecordingStore.setState({
    sessionExpectedCount: clamped,
    userTouchedStepper: true,
  });
  pushConfig(useMeetingRecordingStore.getState().sessionDiarizationEnabled, clamped);
}

function setSystemPartialSpeakerIdentity(speakerId: string | null, speakerName: string | null) {
  systemPartialSpeakerIdValue = speakerId;
  useMeetingRecordingStore.setState({
    systemPartialSpeakerId: speakerId,
    systemPartialSpeakerName: speakerName,
  });
}

function applySpeakerIdentification(
  segment: TranscriptSegment,
  identification: SpeakerIdentification
): TranscriptSegment {
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
}

function rememberSystemSpeaker(
  speakerId: string | null,
  speakerName: string | null,
  speakerIsPlaceholder: boolean,
  updatedAt = Date.now()
) {
  recentSystemSpeaker = speakerId
    ? {
        speakerId,
        speakerName,
        speakerIsPlaceholder,
        updatedAt,
      }
    : null;
}

function getRecentSystemSpeaker(nowMs: number) {
  if (!recentSystemSpeaker) return null;
  return nowMs - recentSystemSpeaker.updatedAt <= SYSTEM_SPEAKER_CARRY_FORWARD_MS
    ? recentSystemSpeaker
    : null;
}

function reserveSpeakerIndex(speakerId?: string) {
  const idx = getSpeakerNumericIndex(speakerId);
  if (idx == null) return;
  nextPlaceholderSpeakerIndex = Math.max(nextPlaceholderSpeakerIndex, idx + 1);
}

function assignProvisionalSpeaker(segment: TranscriptSegment): TranscriptSegment {
  if (segment.source !== "system" || segment.speaker) return segment;

  const nowMs = segment.timestamp ?? Date.now();
  if (systemPartialSpeakerIdValue) {
    reserveSpeakerIndex(systemPartialSpeakerIdValue);
    return normalizeTranscriptSegment({
      ...segment,
      speaker: systemPartialSpeakerIdValue,
      speakerIsPlaceholder: true,
      speakerStatus: "provisional",
    });
  }

  const recent = getRecentSystemSpeaker(nowMs);
  if (recent?.speakerId) {
    reserveSpeakerIndex(recent.speakerId);
    return normalizeTranscriptSegment({
      ...segment,
      speaker: recent.speakerId,
      speakerName: recent.speakerName ?? undefined,
      speakerIsPlaceholder: recent.speakerIsPlaceholder,
      speakerStatus: "provisional",
    });
  }

  const previousSystemSegment = [...segmentsRefValue]
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

  const speakerId = `speaker_${nextPlaceholderSpeakerIndex}`;
  nextPlaceholderSpeakerIndex += 1;

  return normalizeTranscriptSegment({
    ...segment,
    speaker: speakerId,
    speakerIsPlaceholder: true,
    speakerStatus: "provisional",
  });
}

async function cleanup(): Promise<void> {
  await flushAndDisconnectProcessor(micProcessor);
  micProcessor = null;

  micSource?.disconnect();
  micSource = null;

  micAnalyser?.disconnect();
  micAnalyser = null;

  try {
    micStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  micStream = null;

  try {
    await micContext?.close();
  } catch {}
  micContext = null;

  await flushAndDisconnectProcessor(systemProcessor);
  systemProcessor = null;

  systemSource?.disconnect();
  systemSource = null;

  stopMediaStream(systemStream);
  systemStream = null;

  try {
    await systemContext?.close();
  } catch {}
  systemContext = null;

  ipcCleanups.forEach((fn) => fn());
  ipcCleanups = [];
  isPrepared = false;
  isRecordingFlag = false;
  isStartingFlag = false;
}

export async function prepareTranscription(): Promise<void> {
  if (isPrepared || isRecordingFlag || isStartingFlag) return;
  if (preparePromise) return preparePromise;

  logger.info("Meeting transcription preparing (pre-warming WebSockets)...", {}, "meeting");

  const promise = (async () => {
    try {
      const result = await window.electronAPI?.meetingTranscriptionPrepare?.(
        getMeetingTranscriptionOptions()
      );

      if (result?.success) {
        isPrepared = true;
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
      preparePromise = null;
    }
  })();

  preparePromise = promise;
  await promise;
}

export interface StartRecordingArgs {
  noteId: number | null;
  noteTitle: string | null;
  folderId: number | null;
  seedSegments?: TranscriptSegment[];
  expectedCount?: number;
}

export async function startRecording(args: StartRecordingArgs): Promise<void> {
  if (isRecordingFlag || isStartingFlag) return;
  isStartingFlag = true;

  const initialEnabled =
    (getSettings() as { speakerDiarizationEnabled?: boolean }).speakerDiarizationEnabled ?? true;
  const initialCount = Math.max(
    1,
    Math.min(MAX_SPEAKER_COUNT, args.expectedCount ?? DEFAULT_EXPECTED_SPEAKER_COUNT)
  );

  const systemAudioAccessPromise =
    window.electronAPI?.checkSystemAudioAccess?.() ?? Promise.resolve(DEFAULT_SYSTEM_AUDIO_ACCESS);

  logger.info("Meeting transcription starting...", {}, "meeting");
  const seed = args.seedSegments ?? [];
  const locks = new Map<string, string>();
  let maxSpeakerIndex = -1;
  for (const s of seed) {
    const idx = getSpeakerNumericIndex(s.speaker);
    if (idx != null && idx > maxSpeakerIndex) maxSpeakerIndex = idx;
    if (s.speakerLocked && s.speaker && s.speakerName) {
      locks.set(s.speaker, s.speakerName);
    }
  }

  segmentsRefValue = seed;
  speakerIdentifications = [];
  nextPlaceholderSpeakerIndex = maxSpeakerIndex + 1;
  recentSystemSpeaker = null;
  speakerLocks = locks;
  systemPartialSpeakerIdValue = null;

  useMeetingRecordingStore.setState({
    isRecording: true,
    isTranscribing: true,
    recordingNoteId: args.noteId,
    recordingNoteTitle: args.noteTitle,
    recordingFolderId: args.folderId,
    sessionDiarizationEnabled: initialEnabled,
    sessionExpectedCount: initialCount,
    userTouchedStepper: false,
    segments: seed,
    transcript: buildTranscriptText(seed),
    micPartial: "",
    systemPartial: "",
    systemPartialSpeakerId: null,
    systemPartialSpeakerName: null,
    diarizationSessionId: null,
    error: null,
  });

  isRecordingFlag = true;

  if (preparePromise) {
    logger.debug("Waiting for in-flight prepare to finish...", {}, "meeting");
    await preparePromise;
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
        noteId: args.noteId ?? null,
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
    if (!isRecordingFlag) {
      logger.info("Meeting transcription aborted during setup (stop called)", {}, "meeting");
      stopMediaStream(micResult);
      stopMediaStream(systemCaptureResult.stream);
      isStartingFlag = false;
      return;
    }

    if (!startResult?.success) {
      logger.error(
        "Meeting transcription IPC start failed",
        { error: startResult?.error },
        "meeting"
      );
      useMeetingRecordingStore.setState({
        error: startResult?.error || "Failed to start meeting transcription",
        isRecording: false,
        isTranscribing: false,
      });
      stopMediaStream(micResult);
      stopMediaStream(systemCaptureResult.stream);
      isRecordingFlag = false;
      isStartingFlag = false;
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
      useMeetingRecordingStore.setState({
        error: "Microphone capture failed. Continuing with system audio only.",
      });
    }

    if (!micResult && !systemCaptureResult.stream && !systemAudioHandledInMain) {
      logger.error("Meeting transcription has no available audio source", {}, "meeting");
      useMeetingRecordingStore.setState({
        error:
          systemAudioMode === "unsupported"
            ? "No microphone is available and system audio capture is unsupported on this device."
            : systemCaptureError?.message ||
              "No microphone is available and system audio capture could not be started.",
        isRecording: false,
        isTranscribing: false,
      });
      await window.electronAPI?.meetingTranscriptionStop?.();
      isRecordingFlag = false;
      isStartingFlag = false;
      return;
    }

    const segmentCleanup = window.electronAPI?.onMeetingTranscriptionSegment?.(
      (data: {
        text: string;
        source: "mic" | "system";
        type: "partial" | "final" | "retract";
        timestamp?: number;
      }) => {
        if (data.type === "retract") {
          const next = useMeetingRecordingStore
            .getState()
            .segments.filter(
              (seg) =>
                !(
                  seg.source === data.source &&
                  seg.timestamp === data.timestamp &&
                  seg.text === data.text
                )
            );
          segmentsRefValue = next;
          useMeetingRecordingStore.setState({
            segments: next,
            transcript: buildTranscriptText(next),
          });
          return;
        }

        if (data.type === "partial") {
          if (data.source === "mic") {
            useMeetingRecordingStore.setState({ micPartial: data.text });
          } else {
            useMeetingRecordingStore.setState({ systemPartial: data.text });
            if (!systemPartialSpeakerIdValue) {
              const speakerId = `speaker_${nextPlaceholderSpeakerIndex}`;
              nextPlaceholderSpeakerIndex += 1;
              setSystemPartialSpeakerIdentity(speakerId, null);
            }
          }
          return;
        }

        let rawSegment: TranscriptSegment = normalizeTranscriptSegment({
          id: `seg-${++segmentCounter}`,
          text: data.text,
          source: data.source,
          timestamp: data.timestamp,
        });

        for (let i = speakerIdentifications.length - 1; i >= 0; i -= 1) {
          rawSegment = applySpeakerIdentification(rawSegment, speakerIdentifications[i]);
        }

        const provisional = assignProvisionalSpeaker(rawSegment);
        reserveSpeakerIndex(provisional.speaker);
        const lockedName = provisional.speaker
          ? speakerLocks.get(provisional.speaker)
          : undefined;
        const seg = lockedName
          ? lockTranscriptSpeaker(provisional, {
              speakerName: lockedName,
              speakerIsPlaceholder: false,
              suggestedName: undefined,
              suggestedProfileId: undefined,
            })
          : provisional;

        const prev = useMeetingRecordingStore.getState().segments;
        const ts = seg.timestamp ?? Infinity;
        let i = prev.length;
        while (i > 0 && (prev[i - 1].timestamp ?? 0) > ts) i--;
        const next =
          i === prev.length ? [...prev, seg] : [...prev.slice(0, i), seg, ...prev.slice(i)];
        segmentsRefValue = next;

        const partialPatch =
          data.source === "mic" ? { micPartial: "" } : { systemPartial: "" };
        useMeetingRecordingStore.setState({
          segments: next,
          transcript: buildTranscriptText(next),
          ...partialPatch,
        });
        if (data.source === "system" && seg.speaker) {
          rememberSystemSpeaker(
            seg.speaker,
            seg.speakerName ?? null,
            !!seg.speakerIsPlaceholder,
            seg.timestamp ?? Date.now()
          );
        }
        if (data.source === "system") {
          setSystemPartialSpeakerIdentity(null, null);
        }
      }
    );
    if (segmentCleanup) ipcCleanups.push(segmentCleanup);

    const speakerCleanup = window.electronAPI?.onMeetingSpeakerIdentified?.((data) => {
      reserveSpeakerIndex(data.speakerId);
      setSystemPartialSpeakerIdentity(data.speakerId, data.displayName ?? null);
      rememberSystemSpeaker(data.speakerId, data.displayName ?? null, false, data.endTime);
      speakerIdentifications = [
        ...speakerIdentifications.filter(
          (id) => id.endTime >= data.endTime - SPEAKER_IDENTIFICATION_RETENTION_MS
        ),
        data,
      ];
      const next = useMeetingRecordingStore
        .getState()
        .segments.map((segment) => applySpeakerIdentification(segment, data));
      segmentsRefValue = next;
      useMeetingRecordingStore.setState({ segments: next });
    });
    if (speakerCleanup) ipcCleanups.push(speakerCleanup);

    const mergeCleanup = window.electronAPI?.onMeetingSpeakersMerged?.((merges) => {
      let next = useMeetingRecordingStore.getState().segments;
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
      segmentsRefValue = next;
      useMeetingRecordingStore.setState({ segments: next });

      for (const { keep, remove, displayName } of merges) {
        if (recentSystemSpeaker?.speakerId === remove) {
          recentSystemSpeaker.speakerId = keep;
          if (displayName) recentSystemSpeaker.speakerName = displayName;
        }

        for (const id of speakerIdentifications) {
          if (id.speakerId === remove) id.speakerId = keep;
        }

        const lockedName = speakerLocks.get(remove);
        if (lockedName) {
          speakerLocks.set(keep, lockedName);
          speakerLocks.delete(remove);
        }
      }
    });
    if (mergeCleanup) ipcCleanups.push(mergeCleanup);

    const errorCleanup = window.electronAPI?.onMeetingTranscriptionError?.((err) => {
      useMeetingRecordingStore.setState({ error: err });
      logger.error("Meeting transcription stream error", { error: err }, "meeting");
    });
    if (errorCleanup) ipcCleanups.push(errorCleanup);

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
      speakerIdentifications.push(synthetic);
    }

    const pendingMicChunks: ArrayBuffer[] = [];
    const pendingSystemChunks: ArrayBuffer[] = [];
    let socketReady = false;

    let micPipelinePromise: Promise<void> | null = null;
    if (micResult) {
      micStream = micResult;
      const ctx = new AudioContext({ sampleRate: 24000 });
      await detachFromOutputDevice(ctx);
      micContext = ctx;

      micPipelinePromise = createAudioPipeline({
        stream: micResult,
        context: ctx,
        onChunk: (chunk) => {
          if (!isRecordingFlag) return;
          if (socketReady) {
            window.electronAPI?.meetingTranscriptionSend?.(chunk, "mic");
            return;
          }
          pendingMicChunks.push(chunk.slice(0));
        },
      }).then(({ source, processor }) => {
        micSource = source;
        micProcessor = processor;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        micAnalyser = analyser;

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
      const stream = systemCaptureResult.stream;
      systemStream = stream;

      const ctx = new AudioContext({ sampleRate: 24000 });
      await detachFromOutputDevice(ctx);
      systemContext = ctx;

      await createAudioPipeline({
        stream,
        context: ctx,
        onChunk: (chunk) => {
          if (!isRecordingFlag) return;
          if (socketReady) {
            window.electronAPI?.meetingTranscriptionSend?.(chunk, "system");
            return;
          }
          pendingSystemChunks.push(chunk.slice(0));
        },
      }).then(({ source, processor }) => {
        systemSource = source;
        systemProcessor = processor;
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

    if (!isRecordingFlag) {
      logger.info(
        "Meeting transcription aborted during pipeline setup (stop called)",
        {},
        "meeting"
      );
      isStartingFlag = false;
      await cleanup();
      return;
    }

    isStartingFlag = false;
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
        wasPrepared: isPrepared,
      },
      "meeting"
    );
  } catch (err) {
    logger.error(
      "Meeting transcription setup failed",
      { error: (err as Error).message },
      "meeting"
    );
    useMeetingRecordingStore.setState({
      error: (err as Error).message,
      isRecording: false,
      isTranscribing: false,
    });
    isRecordingFlag = false;
    isStartingFlag = false;
    await cleanup();
  }
}

export interface StopRecordingResult {
  diarizationSessionId: string | null;
}

export async function stopRecording(): Promise<StopRecordingResult> {
  if (!isRecordingFlag) {
    return { diarizationSessionId: null };
  }

  isRecordingFlag = false;
  isStartingFlag = false;
  useMeetingRecordingStore.setState({ isRecording: false, isTranscribing: false });

  await cleanup();

  let diarizationSessionId: string | null = null;
  try {
    const result = await window.electronAPI?.meetingTranscriptionStop?.();
    if (result?.diarizationSessionId) {
      diarizationSessionId = result.diarizationSessionId;
      useMeetingRecordingStore.setState({ diarizationSessionId });
    }
    if (result?.success && result.transcript) {
      useMeetingRecordingStore.setState({ transcript: result.transcript });
    } else if (result?.error) {
      useMeetingRecordingStore.setState({ error: result.error });
    }
  } catch (err) {
    useMeetingRecordingStore.setState({ error: (err as Error).message });
    logger.error(
      "Meeting transcription stop failed",
      { error: (err as Error).message },
      "meeting"
    );
  }

  useMeetingRecordingStore.setState({
    micPartial: "",
    systemPartial: "",
    systemPartialSpeakerId: null,
    systemPartialSpeakerName: null,
    currentMicLevel: 0,
  });

  logger.info("Meeting transcription stopped", {}, "meeting");
  return { diarizationSessionId };
}

export function lockSpeaker(speakerId: string, displayName: string): void {
  if (!speakerId || !displayName) return;
  speakerLocks.set(speakerId, displayName);
  const next = useMeetingRecordingStore.getState().segments.map((s) =>
    s.speaker === speakerId
      ? lockTranscriptSpeaker(s, {
          speakerName: displayName,
          speakerIsPlaceholder: false,
          suggestedName: undefined,
          suggestedProfileId: undefined,
        })
      : s
  );
  segmentsRefValue = next;
  useMeetingRecordingStore.setState({ segments: next });
  if (recentSystemSpeaker?.speakerId === speakerId) {
    recentSystemSpeaker = {
      ...recentSystemSpeaker,
      speakerName: displayName,
      speakerIsPlaceholder: false,
    };
  }
  if (systemPartialSpeakerIdValue === speakerId) {
    setSystemPartialSpeakerIdentity(speakerId, displayName);
  }
}

export function cancelPreparedTranscription(): void {
  window.electronAPI?.meetingTranscriptionCancel?.();
}

// Module-load resize subscription. Throttled to ~60ms so layout reflows during
// drag don't thrash React. The store is module-scoped (Phase 1's pattern), so
// registering here once is correct — the listener outlives any view.
if (typeof window !== "undefined") {
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimeout) return;
    resizeTimeout = setTimeout(() => {
      resizeTimeout = null;
      useMeetingRecordingStore.setState({ windowWidth: window.innerWidth });
    }, 60);
  });
}

export function useIsNarrowWindow(): boolean {
  const windowWidth = useMeetingRecordingStore((s) => s.windowWidth);
  return windowWidth < SIDE_PANEL_BREAKPOINT_PX;
}

export function useIsMeetingMode(): boolean {
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const isNarrow = useIsNarrowWindow();
  return isRecording && isNarrow;
}

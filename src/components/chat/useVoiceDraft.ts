import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import { getSettings, useSettingsStore } from "../../stores/settingsStore";
import {
  resolvePreferredMicrophone,
  TRANSCRIPTION_AUDIO_CONSTRAINTS,
} from "../../helpers/microphoneSelection";
import { getBaseLanguageCode } from "../../utils/languageSupport";
import {
  transcribeFile,
  getTranscriptionApiKey,
  resolveFileTranscriptionRoute,
  type FileTranscriptionConfig,
} from "../../services/fileTranscription";
import { analyserRms } from "../../utils/audioLevel";
import { subscribeAuthBoundary } from "../../lib/authRequestContext";

export type VoiceDraftStatus = "idle" | "recording" | "transcribing";

interface UseVoiceDraftOptions {
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  /** Nothing was heard; without it, an empty take is reported through onError. */
  onEmpty?: () => void;
  /** The microphone didn't open; without it, that is reported through onError. */
  onMicError?: (message: string) => void;
  onCaptureEnd?: () => void;
}

// The microphone picked in Settings, with dictation's constraints; the default
// device when that one can't be resolved or opened.
async function openMicrophone(): Promise<MediaStream> {
  try {
    const resolution = await resolvePreferredMicrophone({ settings: getSettings() });
    const deviceId = resolution.device?.deviceId;
    if (deviceId) {
      return await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, ...TRANSCRIPTION_AUDIO_CONSTRAINTS },
      });
    }
  } catch {
    // Fall through to the default device.
  }
  return navigator.mediaDevices.getUserMedia({ audio: { ...TRANSCRIPTION_AUDIO_CONSTRAINTS } });
}

/**
 * Records a mic take in the chat input and runs it through the regular
 * transcription pipeline (all providers, no LLM pass). The transcript is
 * handed back for the caller to place into the input.
 */
export function useVoiceDraft({
  onTranscript,
  onError,
  onEmpty,
  onMicError,
  onCaptureEnd,
}: UseVoiceDraftOptions) {
  // The settings copy, not useAuth(): a sandboxed window (the agent window)
  // can't resolve a session, and would send Cloud users down the BYOK route.
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);
  const settings = useSettings();
  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    cohereModel,
    cloudTranscriptionMode,
    cloudTranscriptionProvider,
    cloudTranscriptionBaseUrl,
    cloudTranscriptionModel,
    preferredLanguage,
    transcriptionMode,
    remoteTranscriptionUrl,
    remoteTranscriptionModel,
  } = settings;
  const cortiEnvironment = useSettingsStore((s) => s.cortiEnvironment);
  const cortiTenant = useSettingsStore((s) => s.cortiTenant);

  const [status, setStatus] = useState<VoiceDraftStatus>("idle");
  const [elapsed, setElapsed] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  // A start still opening the microphone: a stop or cancel meanwhile abandons it.
  const openingRef = useRef<{ abandoned: boolean } | null>(null);
  // The transcription in flight; a cancel abandons it by moving this on.
  const transcriptionRef = useRef(0);
  const transcribingRef = useRef(false);

  const buildConfig = (): FileTranscriptionConfig => ({
    useLocalWhisper,
    localTranscriptionProvider: localTranscriptionProvider as string,
    whisperModel,
    parakeetModel,
    cohereModel,
    isOpenWhisprCloud: isSignedIn && cloudTranscriptionMode === "openwhispr" && !useLocalWhisper,
    getApiKey: () => getTranscriptionApiKey(cloudTranscriptionProvider as string, settings),
    cloudTranscriptionProvider: cloudTranscriptionProvider as string,
    cloudTranscriptionBaseUrl: cloudTranscriptionBaseUrl || "",
    cloudTranscriptionModel,
    // Empty = auto-detect; the resolver supplies a default where one is required.
    language: getBaseLanguageCode(preferredLanguage) || "",
    cortiEnvironment,
    cortiTenant,
    transcriptionMode,
    remoteTranscriptionUrl,
    remoteTranscriptionModel,
  });

  // The chat mic always takes the batch file path, which a realtime-only
  // provider cannot serve; the caller disables the mic rather than letting a
  // take record straight into that failure.
  const config = buildConfig();
  const route =
    config.isOpenWhisprCloud || config.useLocalWhisper
      ? null
      : resolveFileTranscriptionRoute(config);
  const streamingOnlyProvider =
    route?.transport === "error" && route.code === "STREAMING_ONLY_PROVIDER";

  // Latest-value refs so the recorder's onstop (bound at start time) uses
  // current settings and callbacks.
  const buildConfigRef = useRef(buildConfig);
  buildConfigRef.current = buildConfig;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onEmptyRef = useRef(onEmpty);
  onEmptyRef.current = onEmpty;
  const onMicErrorRef = useRef(onMicError);
  onMicErrorRef.current = onMicError;
  const onCaptureEndRef = useRef(onCaptureEnd);
  onCaptureEndRef.current = onCaptureEnd;

  useEffect(() => {
    if (status !== "recording") return;
    setElapsed(0);
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  const readLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    if (contextRef.current?.state === "suspended") {
      void contextRef.current.resume().catch(() => {});
      return 0;
    }
    return analyserRms(analyser, levelBufRef);
  }, []);

  const teardownCapture = useCallback(() => {
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    onCaptureEndRef.current?.();
  }, []);

  const finishRecording = useCallback(async () => {
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    chunksRef.current = [];
    teardownCapture();

    if (discardRef.current || blob.size === 0) {
      setStatus("idle");
      return;
    }

    const transcription = ++transcriptionRef.current;
    const current = () => transcription === transcriptionRef.current;
    transcribingRef.current = true;
    setStatus("transcribing");
    let tempPath: string | null = null;
    try {
      const buffer = await blob.arrayBuffer();
      if (!current()) return;
      const saved = await window.electronAPI.saveTempAudio(buffer);
      tempPath = saved.path;
      if (!current()) return;
      const result = await transcribeFile(tempPath, buildConfigRef.current(), false, {
        purpose: "dictation",
      });
      const text = result.text?.trim();
      if (!current()) return;
      if (!result.success) {
        onErrorRef.current(result.error || "");
      } else if (!text) {
        (onEmptyRef.current ?? (() => onErrorRef.current("")))();
      } else {
        onTranscriptRef.current(text);
      }
    } catch (error) {
      if (current()) onErrorRef.current(error instanceof Error ? error.message : String(error));
    } finally {
      if (tempPath) void window.electronAPI.deleteTempAudio(tempPath);
      if (current()) {
        transcribingRef.current = false;
        setStatus("idle");
      }
    }
  }, [teardownCapture]);

  /** Resolves once the take is recording (true), or failed to start (false). */
  const start = useCallback(async (): Promise<boolean> => {
    // One take at a time: the last one may still be transcribing.
    if (recorderRef.current || openingRef.current || transcribingRef.current) return false;
    const opening = { abandoned: false };
    openingRef.current = opening;
    try {
      const stream = await openMicrophone();
      streamRef.current = stream;
      if (opening.abandoned) {
        teardownCapture();
        return false;
      }
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      // Chrome's pull-based renderer only fills the analyser when the graph
      // reaches the destination; route through a muted gain.
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(analyser);
      analyser.connect(sink);
      sink.connect(context.destination);

      chunksRef.current = [];
      discardRef.current = false;
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => void finishRecording();
      recorder.start(1000);

      recorderRef.current = recorder;
      contextRef.current = context;
      analyserRef.current = analyser;
      setStatus("recording");
      return true;
    } catch (error) {
      teardownCapture();
      (onMicErrorRef.current ?? onErrorRef.current)(
        error instanceof Error ? error.message : String(error)
      );
      return false;
    } finally {
      openingRef.current = null;
    }
  }, [finishRecording, teardownCapture]);

  const stop = useCallback(() => {
    if (openingRef.current) openingRef.current.abandoned = true;
    recorderRef.current?.stop();
  }, []);

  // Discards a take that is recording, and abandons one that is transcribing.
  const cancel = useCallback(() => {
    discardRef.current = true;
    stop();
    if (!transcribingRef.current) return;
    transcriptionRef.current += 1;
    transcribingRef.current = false;
    setStatus("idle");
  }, [stop]);

  // Discard silently if the surface unmounts mid-take.
  useEffect(() => cancel, [cancel]);
  useEffect(() => subscribeAuthBoundary(cancel), [cancel]);

  return { status, elapsed, readLevel, start, stop, cancel, streamingOnlyProvider };
}

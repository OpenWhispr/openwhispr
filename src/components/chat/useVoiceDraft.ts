import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { useSettings } from "../../hooks/useSettings";
import { getSettings } from "../../stores/settingsStore";
import { getBaseLanguageCode } from "../../utils/languageSupport";
import {
  transcribeFile,
  getTranscriptionApiKey,
  type FileTranscriptionConfig,
} from "../../services/fileTranscription";
import { analyserRms } from "../../utils/audioLevel";
import {
  isManagedLocalTranscriptionRuntimeAllowed,
  resolveManagedLocalTranscriptionRuntime,
} from "../../helpers/managedLocalTranscriptionRuntime";
import { captureRuntimeAuthorizationLease } from "../../helpers/runtimeAuthorizationBoundary";
import { usePolicyStore } from "../../stores/policyStore";

export type VoiceDraftStatus = "idle" | "recording" | "transcribing";

interface UseVoiceDraftOptions {
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

/**
 * Records a mic take in the chat input and runs it through the regular
 * transcription pipeline (all providers, no LLM pass). The transcript is
 * handed back for the caller to place into the input.
 */
export function useVoiceDraft({ onTranscript, onError }: UseVoiceDraftOptions) {
  const { isSignedIn } = useAuth();
  useSettings();

  const [status, setStatus] = useState<VoiceDraftStatus>("idle");
  const [elapsed, setElapsed] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const operationGenerationRef = useRef(0);
  const activeRequestIdRef = useRef<string | null>(null);
  const authorizationLeaseRef = useRef<ReturnType<typeof captureRuntimeAuthorizationLease> | null>(
    null
  );

  const buildConfig = (): FileTranscriptionConfig => {
    const settings = getSettings();
    return {
      useLocalWhisper: settings.useLocalWhisper,
      localTranscriptionProvider: settings.localTranscriptionProvider,
      whisperModel: settings.whisperModel,
      parakeetModel: settings.parakeetModel,
      isOpenWhisprCloud:
        isSignedIn && settings.cloudTranscriptionMode === "openwhispr" && !settings.useLocalWhisper,
      getApiKey: () => getTranscriptionApiKey(settings.cloudTranscriptionProvider, settings),
      cloudTranscriptionProvider: settings.cloudTranscriptionProvider,
      cloudTranscriptionBaseUrl: settings.cloudTranscriptionBaseUrl || "",
      cloudTranscriptionModel: settings.cloudTranscriptionModel,
      // Empty = auto-detect; the resolver supplies a default where one is required.
      language: getBaseLanguageCode(settings.preferredLanguage) || "",
      cortiEnvironment: settings.cortiEnvironment,
      cortiTenant: settings.cortiTenant,
      transcriptionMode: settings.transcriptionMode,
      remoteTranscriptionUrl: settings.remoteTranscriptionUrl,
      remoteTranscriptionModel: settings.remoteTranscriptionModel,
    };
  };

  // Latest-value refs so the recorder's onstop (bound at start time) uses
  // current settings and callbacks.
  const buildConfigRef = useRef(buildConfig);
  buildConfigRef.current = buildConfig;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (status !== "recording") return;
    setElapsed(0);
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  const readLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    return analyserRms(analyser, levelBufRef);
  }, []);

  const teardownCapture = useCallback(() => {
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    contextRef.current?.close().catch(() => {});
    contextRef.current = null;
  }, []);

  const finishRecording = useCallback(async () => {
    const operationGeneration = operationGenerationRef.current;
    const authorization = authorizationLeaseRef.current;
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    chunksRef.current = [];
    teardownCapture();

    if (discardRef.current || blob.size === 0 || !authorization?.isCurrent()) {
      authorization?.dispose();
      if (authorizationLeaseRef.current === authorization) authorizationLeaseRef.current = null;
      setStatus("idle");
      return;
    }

    setStatus("transcribing");
    let tempPath: string | null = null;
    let requestId: string | null = null;
    try {
      authorization.assertCurrent();
      const buffer = await blob.arrayBuffer();
      authorization.assertCurrent();
      const saved = await window.electronAPI.saveTempAudio(buffer);
      tempPath = saved.path;
      authorization.assertCurrent();
      const runtime = resolveManagedLocalTranscriptionRuntime(buildConfigRef.current());
      if (!isManagedLocalTranscriptionRuntimeAllowed(runtime, usePolicyStore.getState())) {
        throw new Error("Transcription is restricted by your organization.");
      }
      if (runtime.kind === "error") throw Object.assign(new Error(runtime.message), runtime);
      requestId = crypto.randomUUID();
      activeRequestIdRef.current = requestId;
      authorization.assertCurrent();
      const result = await transcribeFile(tempPath, runtime.settings, false, { requestId });
      authorization.assertCurrent();
      if (operationGeneration !== operationGenerationRef.current || discardRef.current) return;
      const text = result.text?.trim();
      if (!result.success || !text) {
        onErrorRef.current(result.error || "");
      } else {
        onTranscriptRef.current(text);
      }
    } catch (error) {
      if (
        operationGeneration !== operationGenerationRef.current ||
        discardRef.current ||
        (error as { code?: string }).code === "AUTHORIZATION_BOUNDARY_CHANGED"
      ) {
        return;
      }
      onErrorRef.current(error instanceof Error ? error.message : String(error));
    } finally {
      if (activeRequestIdRef.current === requestId) activeRequestIdRef.current = null;
      if (tempPath) void window.electronAPI.deleteTempAudio(tempPath);
      authorization.dispose();
      if (authorizationLeaseRef.current === authorization) authorizationLeaseRef.current = null;
      if (operationGeneration === operationGenerationRef.current) setStatus("idle");
    }
  }, [teardownCapture]);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    const operationGeneration = ++operationGenerationRef.current;
    const authorization = captureRuntimeAuthorizationLease("transcription", () => {
      if (operationGeneration !== operationGenerationRef.current) return;
      operationGenerationRef.current += 1;
      discardRef.current = true;
      const requestId = activeRequestIdRef.current;
      activeRequestIdRef.current = null;
      if (requestId) void window.electronAPI.cancelUploadTranscription?.(requestId);
      recorderRef.current?.stop();
      setStatus("idle");
    });
    authorizationLeaseRef.current?.dispose();
    authorizationLeaseRef.current = authorization;
    let stream: MediaStream | null = null;
    try {
      const runtime = resolveManagedLocalTranscriptionRuntime(buildConfigRef.current());
      if (!isManagedLocalTranscriptionRuntimeAllowed(runtime, usePolicyStore.getState())) {
        throw new Error("Transcription is restricted by your organization.");
      }
      authorization.assertCurrent();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      authorization.assertCurrent();
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
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
      streamRef.current = stream;
      contextRef.current = context;
      analyserRef.current = analyser;
      setStatus("recording");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      teardownCapture();
      authorization.dispose();
      if (authorizationLeaseRef.current === authorization) authorizationLeaseRef.current = null;
      if (
        operationGeneration !== operationGenerationRef.current ||
        (error as { code?: string }).code === "AUTHORIZATION_BOUNDARY_CHANGED"
      ) {
        return;
      }
      onErrorRef.current(error instanceof Error ? error.message : String(error));
    }
  }, [finishRecording, teardownCapture]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    discardRef.current = true;
    operationGenerationRef.current += 1;
    const requestId = activeRequestIdRef.current;
    activeRequestIdRef.current = null;
    if (requestId) void window.electronAPI.cancelUploadTranscription?.(requestId);
    recorderRef.current?.stop();
    setStatus("idle");
  }, []);

  // Discard silently if the surface unmounts mid-take.
  useEffect(
    () => () => {
      discardRef.current = true;
      operationGenerationRef.current += 1;
      const requestId = activeRequestIdRef.current;
      activeRequestIdRef.current = null;
      if (requestId) void window.electronAPI.cancelUploadTranscription?.(requestId);
      authorizationLeaseRef.current?.dispose();
      authorizationLeaseRef.current = null;
      recorderRef.current?.stop();
    },
    []
  );

  return { status, elapsed, readLevel, start, stop, cancel };
}

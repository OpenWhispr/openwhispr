import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { useSettings } from "../../hooks/useSettings";
import { useSettingsStore } from "../../stores/settingsStore";
import { getBaseLanguageCode } from "../../utils/languageSupport";
import {
  transcribeFile,
  getTranscriptionApiKey,
  type FileTranscriptionConfig,
} from "../../services/fileTranscription";
import { analyserRms } from "../../utils/audioLevel";

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
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    chunksRef.current = [];
    teardownCapture();

    if (discardRef.current || blob.size === 0) {
      setStatus("idle");
      return;
    }

    setStatus("transcribing");
    let tempPath: string | null = null;
    try {
      const buffer = await blob.arrayBuffer();
      const saved = await window.electronAPI.saveTempAudio(buffer);
      tempPath = saved.path;
      const result = await transcribeFile(tempPath, buildConfigRef.current(), false);
      const text = result.text?.trim();
      if (!result.success || !text) {
        onErrorRef.current(result.error || "");
      } else {
        onTranscriptRef.current(text);
      }
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : String(error));
    } finally {
      if (tempPath) void window.electronAPI.deleteTempAudio(tempPath);
      setStatus("idle");
    }
  }, [teardownCapture]);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      teardownCapture();
      onErrorRef.current(error instanceof Error ? error.message : String(error));
    }
  }, [finishRecording, teardownCapture]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    discardRef.current = true;
    recorderRef.current?.stop();
  }, []);

  // Discard silently if the surface unmounts mid-take.
  useEffect(
    () => () => {
      discardRef.current = true;
      recorderRef.current?.stop();
    },
    []
  );

  return { status, elapsed, readLevel, start, stop, cancel };
}

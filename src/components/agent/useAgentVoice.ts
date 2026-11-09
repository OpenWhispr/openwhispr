import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceDraft } from "../chat/useVoiceDraft";
import { playStartCue, playStopCue } from "../../utils/dictationCues";
import { getSettings } from "../../stores/settingsStore";
import { expandSnippets } from "../../utils/snippets";

/** What a finished take is for: a request to send, or text for the typed draft. */
export type AgentVoiceIntent = "submit" | "draft";

interface UseAgentVoiceOptions {
  onTranscript: (text: string, intent: AgentVoiceIntent) => void;
  onEmpty: () => void;
  onError: (message: string) => void;
  onMicError: (message: string) => void;
}

/**
 * The agent window's voice input: a batch take through the user's
 * transcription settings (useVoiceDraft), told to main so dictation stays off
 * the microphone, with dictation's cues, snippets, and a global Esc while
 * recording. One take at a time: a new one starts only once the last one has
 * been transcribed or cancelled, so a take's intent is the one its stop set.
 */
export function useAgentVoice({
  onTranscript,
  onEmpty,
  onError,
  onMicError,
}: UseAgentVoiceOptions) {
  const intentRef = useRef<AgentVoiceIntent>("submit");
  // The microphone is opening: the pill already listens, its waveform still flat.
  const [opening, setOpening] = useState(false);
  const attemptRef = useRef<{ id: string; abandoned: boolean } | null>(null);
  const openingRef = useRef(false);
  const captureEndedRef = useRef(true);
  const report = useCallback((state: "idle" | "recording" | "transcribing") => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    if (state === "idle") attemptRef.current = null;
    void window.electronAPI?.agentWindowSetVoiceState?.(state, attempt.id).catch(() => {});
  }, []);
  const voice = useVoiceDraft({
    onTranscript: (text) =>
      onTranscript(expandSnippets(text, getSettings().snippets), intentRef.current),
    onEmpty,
    onError,
    onMicError,
    onCaptureEnd: () => {
      captureEndedRef.current = true;
      if (attemptRef.current?.abandoned) report("idle");
    },
  });
  const { status, start: startTake, stop: stopTake, cancel: cancelTake } = voice;

  useEffect(() => {
    if (!openingRef.current) report(status);
  }, [status, opening, report]);

  const cancel = useCallback(() => {
    if (attemptRef.current) attemptRef.current.abandoned = true;
    cancelTake();
    if (!openingRef.current && captureEndedRef.current) report("idle");
  }, [cancelTake, report]);
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => () => cancelRef.current(), []);

  // Esc belongs to the take while it records, however it ends.
  useEffect(() => {
    if (status !== "recording") return undefined;
    void window.electronAPI?.registerCancelHotkey?.("Escape");
    return () => void window.electronAPI?.unregisterCancelHotkey?.();
  }, [status]);

  // Main refuses while dictation is using the microphone.
  const start = useCallback(async (): Promise<"started" | "refused" | "failed"> => {
    if (attemptRef.current || openingRef.current || status !== "idle") return "failed";
    const attempt = { id: crypto.randomUUID(), abandoned: false };
    attemptRef.current = attempt;
    openingRef.current = true;
    setOpening(true);
    let started = false;
    try {
      const admitted = await window.electronAPI?.agentWindowSetVoiceState?.(
        "recording",
        attempt.id
      );
      if (admitted !== true) return "refused";
      if (attempt.abandoned) return "failed";
      captureEndedRef.current = false;
      started = await startTake();
      if (!started || attempt.abandoned) {
        if (started) cancelTake();
        return "failed";
      }
      intentRef.current = "submit";
      void playStartCue();
      return "started";
    } catch {
      return "refused";
    } finally {
      openingRef.current = false;
      setOpening(false);
      if (!started && attemptRef.current === attempt) report("idle");
    }
  }, [startTake, cancelTake, report, status]);

  const stop = useCallback(
    (intent: AgentVoiceIntent) => {
      intentRef.current = intent;
      if (openingRef.current && attemptRef.current) attemptRef.current.abandoned = true;
      if (status === "recording") void playStopCue();
      stopTake();
    },
    [status, stopTake]
  );

  return {
    status,
    opening,
    readLevel: voice.readLevel,
    streamingOnlyProvider: voice.streamingOnlyProvider,
    start,
    stop,
    cancel,
  };
}

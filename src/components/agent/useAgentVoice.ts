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
  const voice = useVoiceDraft({
    onTranscript: (text) =>
      onTranscript(expandSnippets(text, getSettings().snippets), intentRef.current),
    onEmpty,
    onError,
    onMicError,
  });
  const { status, start: startTake, stop: stopTake, cancel: cancelTake } = voice;

  useEffect(() => {
    void window.electronAPI?.agentWindowSetVoiceState?.(status);
  }, [status]);
  // An error screen or a reload unmounts this mid-take: release the microphone lock.
  useEffect(() => () => void window.electronAPI?.agentWindowSetVoiceState?.("idle"), []);

  // Esc belongs to the take while it records, however it ends.
  useEffect(() => {
    if (status !== "recording") return undefined;
    void window.electronAPI?.registerCancelHotkey?.("Escape");
    return () => void window.electronAPI?.unregisterCancelHotkey?.();
  }, [status]);

  // Main refuses while dictation is using the microphone.
  const start = useCallback(async (): Promise<"started" | "refused" | "failed"> => {
    if (!(await window.electronAPI?.agentWindowSetVoiceState?.("recording"))) return "refused";
    setOpening(true);
    const started = await startTake();
    setOpening(false);
    if (!started) {
      void window.electronAPI?.agentWindowSetVoiceState?.("idle");
      return "failed";
    }
    // Only now: a refused start must not change what the last take was for.
    intentRef.current = "submit";
    void playStartCue();
    return "started";
  }, [startTake]);

  const stop = useCallback(
    (intent: AgentVoiceIntent) => {
      intentRef.current = intent;
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
    cancel: cancelTake,
  };
}

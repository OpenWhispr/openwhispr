import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceDraft } from "../chat/useVoiceDraft";
import { playStartCue, playStopCue } from "../../utils/dictationCues";

/** What a finished take is for: a request to send, or text for the typed draft. */
export type AgentVoiceIntent = "submit" | "draft";

interface UseAgentVoiceOptions {
  onTranscript: (text: string, intent: AgentVoiceIntent) => void;
  onEmpty: () => void;
  onError: (message: string) => void;
}

/**
 * The agent window's voice input: a batch take through the user's
 * transcription settings (useVoiceDraft), told to main so dictation stays off
 * the microphone, with dictation's cues and a global Esc while recording.
 */
export function useAgentVoice({ onTranscript, onEmpty, onError }: UseAgentVoiceOptions) {
  const intentRef = useRef<AgentVoiceIntent>("submit");
  // The microphone is opening: the pill already listens, its waveform still flat.
  const [opening, setOpening] = useState(false);
  const voice = useVoiceDraft({
    onTranscript: (text) => onTranscript(text, intentRef.current),
    onEmpty,
    onError,
  });
  const { status, start: startTake, stop: stopTake, cancel: cancelTake } = voice;

  useEffect(() => {
    void window.electronAPI?.agentWindowSetVoiceState?.(status);
  }, [status]);

  // Main refuses while dictation is using the microphone.
  const start = useCallback(async (): Promise<"started" | "refused" | "failed"> => {
    if (!(await window.electronAPI?.agentWindowSetVoiceState?.("recording"))) return "refused";
    intentRef.current = "submit";
    setOpening(true);
    const started = await startTake();
    setOpening(false);
    if (!started) {
      void window.electronAPI?.agentWindowSetVoiceState?.("idle");
      return "failed";
    }
    void window.electronAPI?.registerCancelHotkey?.("Escape");
    void playStartCue();
    return "started";
  }, [startTake]);

  const stop = useCallback(
    (intent: AgentVoiceIntent) => {
      intentRef.current = intent;
      void window.electronAPI?.unregisterCancelHotkey?.();
      if (status === "recording") void playStopCue();
      stopTake();
    },
    [status, stopTake]
  );

  const cancel = useCallback(() => {
    void window.electronAPI?.unregisterCancelHotkey?.();
    cancelTake();
  }, [cancelTake]);

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

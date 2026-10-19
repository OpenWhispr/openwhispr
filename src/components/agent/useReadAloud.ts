import { useCallback, useEffect, useState } from "react";
import { markdownToPlainText } from "../../helpers/markdownToPlainText";

// Chromium stops a long utterance part-way (around 15 seconds on some
// voices), so an answer is spoken a sentence at a time.
export function splitIntoUtterances(text: string): string[] {
  return (text.match(/[^.!?。！？\n]+[.!?。！？]*\n*/g) ?? [])
    .map((part) => part.trim())
    .filter(Boolean);
}

// A voice in the UI language, its region's own first; the system default otherwise.
export function pickVoice(
  voices: ReadonlyArray<SpeechSynthesisVoice>,
  language: string
): SpeechSynthesisVoice | null {
  const wanted = language.toLowerCase();
  const base = wanted.split("-")[0];
  return (
    voices.find((voice) => voice.lang.toLowerCase() === wanted) ??
    voices.find((voice) => voice.lang.toLowerCase().split("-")[0] === base) ??
    null
  );
}

const synthesis = (): SpeechSynthesis | null =>
  typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;

/**
 * Reads one answer aloud at a time through the system's speech voices. Not
 * offered where there are none (Linux without speech-dispatcher).
 */
export function useReadAloud(language: string) {
  const [available, setAvailable] = useState(() => (synthesis()?.getVoices().length ?? 0) > 0);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  useEffect(() => {
    const synth = synthesis();
    if (!synth) return;
    const update = () => setAvailable(synth.getVoices().length > 0);
    update();
    synth.addEventListener("voiceschanged", update);
    return () => synth.removeEventListener("voiceschanged", update);
  }, []);

  const stop = useCallback(() => {
    synthesis()?.cancel();
    setSpeakingId(null);
  }, []);

  const speak = useCallback(
    (id: string, markdown: string) => {
      const synth = synthesis();
      if (!synth) return;
      synth.cancel();
      const parts = splitIntoUtterances(markdownToPlainText(markdown));
      if (!parts.length) return;
      const voice = pickVoice(synth.getVoices(), language);
      const finished = () => setSpeakingId((current) => (current === id ? null : current));
      parts.forEach((part, index) => {
        const utterance = new SpeechSynthesisUtterance(part);
        if (voice) utterance.voice = voice;
        utterance.lang = voice?.lang ?? language;
        if (index === parts.length - 1) utterance.onend = finished;
        // Fires for every queued part when speech is cancelled or fails.
        utterance.onerror = finished;
        synth.speak(utterance);
      });
      setSpeakingId(id);
    },
    [language]
  );

  const toggle = useCallback(
    (id: string, markdown: string) => {
      if (speakingId === id) stop();
      else speak(id, markdown);
    },
    [speak, speakingId, stop]
  );

  useEffect(() => () => synthesis()?.cancel(), []);

  return { available, speakingId, toggle, stop };
}

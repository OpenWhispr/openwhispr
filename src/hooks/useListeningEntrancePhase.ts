import { useLayoutEffect, useState } from "react";
import { getListeningEntranceTimeline } from "../helpers/voicePillPresentation";

export type ListeningEntrancePhase = "idle" | "thinking" | "expanding" | "settled" | "waveform";

/**
 * Drives the recording pill's entrance choreography (thinking → expanding →
 * settled → waveform). The main pill and the Agent companion pill share this
 * single timeline so their entrances can never drift apart.
 */
export function useListeningEntrancePhase(isRecording: boolean): ListeningEntrancePhase {
  const [phase, setPhase] = useState<ListeningEntrancePhase>("idle");

  useLayoutEffect(() => {
    if (!isRecording) {
      setPhase("idle");
      return undefined;
    }

    setPhase("thinking");
    const timeline = getListeningEntranceTimeline();
    const expansionTimer = setTimeout(() => setPhase("expanding"), timeline.expandAtMs);
    const settledTimer = setTimeout(() => setPhase("settled"), timeline.settleAtMs);
    const waveformTimer = setTimeout(() => setPhase("waveform"), timeline.waveformAtMs);
    return () => {
      clearTimeout(expansionTimer);
      clearTimeout(settledTimer);
      clearTimeout(waveformTimer);
    };
  }, [isRecording]);

  return phase;
}

import { useLayoutEffect, useRef, useState } from "react";
import { getListeningEntranceTimeline } from "../helpers/voicePillPresentation";

export type ListeningEntrancePhase = "idle" | "thinking" | "expanding" | "settled" | "waveform";

/**
 * Drives the recording pill's entrance choreography (thinking → expanding →
 * settled → waveform). The main pill and the Agent companion pill share this
 * single timeline so their entrances can never drift apart (recording-visual
 * ownership guarantees only one of them runs it at a time).
 */
export function useListeningEntrancePhase(
  isRecording: boolean,
  options?: {
    /** The recording starts under the open assistant panel, whose footer must
     *  finish handing final actions back to the pill before the expansion may
     *  begin — this stretches the thinking hold past that handoff. Sampled at
     *  the recording edge, so a panel closing mid-recording cannot restart
     *  the entrance. */
    afterAssistantFooterHandoff?: boolean;
  }
): ListeningEntrancePhase {
  const [phase, setPhase] = useState<ListeningEntrancePhase>("idle");
  const afterFooterRef = useRef(options?.afterAssistantFooterHandoff ?? false);
  afterFooterRef.current = options?.afterAssistantFooterHandoff ?? false;

  useLayoutEffect(() => {
    if (!isRecording) {
      setPhase("idle");
      return undefined;
    }

    setPhase("thinking");
    const timeline = getListeningEntranceTimeline({
      afterAssistantFooterHandoff: afterFooterRef.current,
    });
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

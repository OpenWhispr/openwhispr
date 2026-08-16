import React, { useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import {
  resolveAgentWaveformBarHeight,
  resolveWaveformBarHeight,
  WAVEFORM_BAR_COUNT,
  WAVEFORM_BAR_MIN_PX,
} from "./waveformMath";

interface LiveWaveformProps {
  /** Returns the current input level (0..~1) or null when no signal source exists. */
  getLevel: () => number | null;
  /** While true the bars scroll with live levels; false freezes the captured wave. */
  active: boolean;
  /** Adds the muted Agent echo behind a traveling neutral highlight. */
  agentMode?: boolean;
  className?: string;
}

const SAMPLE_INTERVAL_MS = 60;

/**
 * Level-driven waveform: bars scroll right-to-left with the live input signal.
 * Heights are written directly to the DOM from a rAF loop so recording never
 * pays React re-render cost. With no signal (getLevel → null) the bars rest at
 * minimum height; when `active` goes false the last captured wave stays frozen.
 */
export function LiveWaveform({
  getLevel,
  active,
  agentMode = false,
  className,
}: LiveWaveformProps) {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const agentBarRefs = useRef<(HTMLDivElement | null)[]>([]);
  const levelsRef = useRef<number[]>([]);

  useEffect(() => {
    if (!active) return;

    // A new recording starts from silence — never replay the previous
    // session's frozen wave.
    levelsRef.current = new Array(WAVEFORM_BAR_COUNT).fill(0);
    for (let index = 0; index < WAVEFORM_BAR_COUNT; index += 1) {
      const height = `${WAVEFORM_BAR_MIN_PX}px`;
      if (barRefs.current[index]) barRefs.current[index].style.height = height;
      if (agentBarRefs.current[index]) agentBarRefs.current[index].style.height = height;
    }

    let frame = 0;
    let lastSample = 0;
    const paint = (now: number) => {
      if (now - lastSample >= SAMPLE_INTERVAL_MS) {
        lastSample = now;
        const level = getLevel();
        const levels = levelsRef.current;
        levels.shift();
        levels.push(level === null ? 0 : level);
        for (let i = 0; i < levels.length; i++) {
          const bar = barRefs.current[i];
          const agentBar = agentBarRefs.current[i];
          if (bar) bar.style.height = `${resolveWaveformBarHeight(levels[i])}px`;
          if (agentBar) {
            agentBar.style.height = `${resolveAgentWaveformBarHeight(levels, i)}px`;
          }
        }
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [active, getLevel]);

  return (
    <div className={cn("relative isolate h-full", className)} aria-hidden="true">
      {agentMode && (
        <div
          className="agent-waveform-background pointer-events-none absolute inset-0 z-0 flex items-center justify-center gap-0.75 text-agent-brand"
          data-active={active || undefined}
        >
          {Array.from({ length: WAVEFORM_BAR_COUNT }, (_, i) => (
            <div
              key={i}
              ref={(el) => {
                agentBarRefs.current[i] = el;
              }}
              className="w-0.5 rounded-full bg-current transition-[height] duration-75 ease-out motion-reduce:transition-none"
              style={{ height: WAVEFORM_BAR_MIN_PX }}
            />
          ))}
        </div>
      )}

      <div
        className="agent-waveform-foreground relative z-10 flex h-full items-center justify-center gap-0.75"
        data-agent-mode={agentMode || undefined}
        data-active={active || undefined}
      >
        {Array.from({ length: WAVEFORM_BAR_COUNT }, (_, i) => (
          <div
            key={i}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
            className="w-0.5 rounded-full bg-current transition-[height] duration-75 ease-out motion-reduce:transition-none"
            style={{ height: WAVEFORM_BAR_MIN_PX }}
          />
        ))}
      </div>
    </div>
  );
}

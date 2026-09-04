import { useEffect, useRef, type RefObject } from "react";
import { cn } from "../lib/utils";
import {
  AGENT_MODE_PATH,
  resolveVoiceIdentityMorphPaths,
  VOICE_IDENTITY_MORPH_DURATION_MS,
} from "./voiceIdentityMorph";

interface VoiceIdentityIconProps {
  size?: number;
  agentMode?: boolean;
  className?: string;
}

const setPath = (ref: RefObject<SVGPathElement | null>, path: string, opacity: number) => {
  ref.current?.setAttribute("d", path);
  if (ref.current) ref.current.style.opacity = String(opacity);
};

/**
 * A real one-SVG morph: the listening ring becomes a leaf contour, its audio
 * bars bend into the leaf structure, and the left bar emits the Agent spark.
 */
export function VoiceIdentityIcon({
  size = 24,
  agentMode = false,
  className,
}: VoiceIdentityIconProps) {
  const progressRef = useRef(agentMode ? 1 : 0);
  const shellRef = useRef<SVGPathElement>(null);
  const leftBarRef = useRef<SVGPathElement>(null);
  const centerBarRef = useRef<SVGPathElement>(null);
  const rightBarRef = useRef<SVGPathElement>(null);
  const sparkCrossRef = useRef<SVGPathElement>(null);
  const agentRef = useRef<SVGPathElement>(null);
  const renderedMorph = resolveVoiceIdentityMorphPaths(progressRef.current);

  useEffect(() => {
    const target = agentMode ? 1 : 0;
    const start = progressRef.current;
    const distance = Math.abs(target - start);

    const applyProgress = (progress: number) => {
      const morph = resolveVoiceIdentityMorphPaths(progress);
      progressRef.current = progress;
      setPath(shellRef, morph.shell, morph.constructionOpacity);
      setPath(leftBarRef, morph.leftBar, morph.constructionOpacity);
      setPath(centerBarRef, morph.centerBar, morph.constructionOpacity);
      setPath(rightBarRef, morph.rightBar, morph.constructionOpacity);
      setPath(sparkCrossRef, morph.sparkCross, morph.sparkOpacity);
      if (agentRef.current) agentRef.current.style.opacity = String(morph.agentOpacity);
    };

    if (distance === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      applyProgress(target);
      return;
    }

    const startedAt = performance.now();
    const duration = VOICE_IDENTITY_MORPH_DURATION_MS * distance;
    let frame = 0;

    const animate = (now: number) => {
      const elapsed = Math.min(1, (now - startedAt) / duration);
      const eased = elapsed < 0.5 ? 4 * elapsed ** 3 : 1 - (-2 * elapsed + 2) ** 3 / 2;
      applyProgress(start + (target - start) * eased);
      if (elapsed < 1) frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [agentMode]);

  return (
    <span
      className={cn("voice-identity-icon relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      data-agent-mode={agentMode ? "true" : "false"}
      aria-hidden="true"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className="voice-identity-svg absolute inset-0 overflow-visible"
        aria-hidden="true"
      >
        <g className="voice-identity-construction">
          <path
            ref={shellRef}
            className="voice-identity-morph-shell"
            d={renderedMorph.shell}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: renderedMorph.constructionOpacity }}
          />
          <path
            ref={leftBarRef}
            className="voice-identity-morph-bar voice-identity-morph-bar-left"
            d={renderedMorph.leftBar}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ opacity: renderedMorph.constructionOpacity }}
          />
          <path
            ref={centerBarRef}
            className="voice-identity-morph-bar voice-identity-morph-bar-center"
            d={renderedMorph.centerBar}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ opacity: renderedMorph.constructionOpacity }}
          />
          <path
            ref={rightBarRef}
            className="voice-identity-morph-bar voice-identity-morph-bar-right"
            d={renderedMorph.rightBar}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ opacity: renderedMorph.constructionOpacity }}
          />
          <path
            ref={sparkCrossRef}
            className="voice-identity-morph-spark"
            d={renderedMorph.sparkCross}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ opacity: renderedMorph.sparkOpacity }}
          />
        </g>
        <path
          ref={agentRef}
          className="voice-identity-final-agent"
          d={AGENT_MODE_PATH}
          fill="currentColor"
          transform="scale(1.2)"
          style={{ opacity: renderedMorph.agentOpacity }}
        />
      </svg>
    </span>
  );
}

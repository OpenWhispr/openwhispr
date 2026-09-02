import { cn } from "../lib/utils";

interface CardCountdownArcProps {
  /** Card width in CSS px; the arc stretches to the rendered width. */
  width: number;
  /** Card corner radius in CSS px, so the arc follows both top corners. */
  radius: number;
  durationMs: number;
  paused?: boolean;
  className?: string;
}

/** Auto-dismiss countdown drawn along a floating card's top edge. */
export function CardCountdownArc({
  width,
  radius,
  durationMs,
  paused = false,
  className,
}: CardCountdownArcProps) {
  const path = `M 1 ${radius + 1} A ${radius} ${radius} 0 0 1 ${radius + 1} 1 H ${width - radius - 1} A ${radius} ${radius} 0 0 1 ${width - 1} ${radius + 1}`;

  return (
    <svg
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-10 w-full overflow-visible text-foreground",
        className
      )}
      style={{ height: radius + 1 }}
      viewBox={`0 0 ${width} ${radius + 2}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="butt"
        pathLength="1"
        strokeDasharray="1"
        style={{
          animation: `toast-border-progress ${durationMs}ms linear forwards`,
          animationPlayState: paused ? "paused" : "running",
        }}
      />
    </svg>
  );
}

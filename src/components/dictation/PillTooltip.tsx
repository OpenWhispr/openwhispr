import { useState } from "react";
import type React from "react";

interface PillTooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  emoji?: string;
  align?: "left" | "right" | "center";
  disabled?: boolean;
}

/**
 * Minimal hover tooltip for the dictation pill. The pill window is tiny and
 * frameless, so this stays lighter than the app-wide Radix tooltip and can be
 * aligned against the pill's docked edge.
 */
export function PillTooltip({
  children,
  content,
  emoji,
  align = "center",
  disabled = false,
}: PillTooltipProps): React.JSX.Element {
  const [isVisible, setIsVisible] = useState(false);

  const alignClass =
    align === "right" ? "right-0" : align === "left" ? "left-0" : "left-1/2 -translate-x-1/2";

  const arrowClass =
    align === "right" ? "right-3" : align === "left" ? "left-3" : "left-1/2 -translate-x-1/2";

  return (
    <div className="relative inline-block">
      <div onMouseEnter={() => setIsVisible(true)} onMouseLeave={() => setIsVisible(false)}>
        {children}
      </div>
      {isVisible && !disabled && (
        <div
          className={`absolute bottom-full ${alignClass} mb-2 px-1.5 py-1 text-[10px] text-popover-foreground bg-popover border border-border rounded-full z-10 shadow-lg transition-opacity duration-150 whitespace-nowrap`}
        >
          {emoji && <span className="mr-1">{emoji}</span>}
          {content}
          <div
            className={`absolute top-full ${arrowClass} w-0 h-0 border-l-2 border-r-2 border-t-2 border-transparent border-t-popover`}
          ></div>
        </div>
      )}
    </div>
  );
}

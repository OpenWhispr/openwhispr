import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  children: React.ReactNode;
  content: string;
}

export const Tooltip = ({ children, content }: TooltipProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPosition({
      top: rect.top,
      left: rect.left + rect.width / 2,
    });
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    updatePosition();
  }, [isVisible, updatePosition]);

  // Adjust if tooltip overflows viewport edges
  useEffect(() => {
    if (!isVisible || !position || !tooltipRef.current) return;
    const tooltip = tooltipRef.current;
    const tooltipRect = tooltip.getBoundingClientRect();

    let adjustedLeft = position.left;
    if (tooltipRect.left < 4) {
      adjustedLeft = tooltipRect.width / 2 + 4;
    } else if (tooltipRect.right > window.innerWidth - 4) {
      adjustedLeft = window.innerWidth - tooltipRect.width / 2 - 4;
    }

    if (adjustedLeft !== position.left) {
      setPosition((prev) => (prev ? { ...prev, left: adjustedLeft } : prev));
    }
  }, [isVisible, position]);

  return (
    <>
      <div
        ref={triggerRef}
        className="relative inline-flex"
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
      >
        {children}
      </div>
      {isVisible &&
        position &&
        createPortal(
          <div
            ref={tooltipRef}
            className="fixed px-2.5 py-1.5 text-xs font-medium text-popover-foreground bg-popover border border-border rounded-md whitespace-nowrap z-[9999] shadow-lg animate-in fade-in-0 zoom-in-95 duration-150 pointer-events-none"
            style={{
              top: position.top,
              left: position.left,
              transform: "translate(-50%, calc(-100% - 8px))",
            }}
          >
            {content}
            <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-popover" />
          </div>,
          document.body
        )}
    </>
  );
};

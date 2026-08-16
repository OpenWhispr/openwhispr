import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/utils";

interface ExpandingPanelShellProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  open: boolean;
  anchor?: "bottom-left" | "bottom-right";
  stabilizeHeight?: boolean;
  onPreferredHeightChange?: (height: number) => void;
  children: ReactNode;
}

/** Shared surface for pill-to-panel transitions; callers own only their inner layout. */
export function ExpandingPanelShell({
  open,
  anchor = "bottom-right",
  stabilizeHeight = false,
  onPreferredHeightChange,
  children,
  className,
  style,
  ...props
}: ExpandingPanelShellProps) {
  const shellRef = useRef<HTMLElement | null>(null);
  const lastPreferredHeightRef = useRef(0);
  const heightFloorRef = useRef(0);
  const [heightFloor, setHeightFloor] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (stabilizeHeight) {
      if (lastPreferredHeightRef.current > 0) {
        heightFloorRef.current = lastPreferredHeightRef.current;
        setHeightFloor(lastPreferredHeightRef.current);
      }
      return;
    }

    heightFloorRef.current = 0;
    setHeightFloor(null);
  }, [stabilizeHeight]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell || !onPreferredHeightChange) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const shellStyle = window.getComputedStyle(shell);
      let preferredHeight =
        Number.parseFloat(shellStyle.borderTopWidth) +
        Number.parseFloat(shellStyle.borderBottomWidth);

      for (const child of Array.from(shell.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const childStyle = window.getComputedStyle(child);
        const verticalMargins =
          Number.parseFloat(childStyle.marginTop) + Number.parseFloat(childStyle.marginBottom);
        preferredHeight += Math.max(child.offsetHeight, child.scrollHeight) + verticalMargins;
      }

      preferredHeight = Math.ceil(preferredHeight);
      if (stabilizeHeight && preferredHeight > heightFloorRef.current) {
        heightFloorRef.current = preferredHeight;
        setHeightFloor(preferredHeight);
      }

      const reportedHeight = stabilizeHeight
        ? Math.max(preferredHeight, heightFloorRef.current)
        : preferredHeight;
      if (Math.abs(reportedHeight - lastPreferredHeightRef.current) < 1) return;
      lastPreferredHeightRef.current = reportedHeight;
      onPreferredHeightChange(reportedHeight);
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(shell);
    for (const child of Array.from(shell.children)) resizeObserver.observe(child);
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(shell, { childList: true, characterData: true, subtree: true });
    scheduleMeasure();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [onPreferredHeightChange, stabilizeHeight]);

  return (
    <section
      ref={shellRef}
      className={cn(
        "expanding-panel-surface absolute inset-x-3 bottom-3 flex h-fit max-h-[calc(100%-1.5rem)] flex-col overflow-hidden",
        "rounded-3xl border border-border/50 bg-surface-0",
        "shadow-[var(--shadow-modal)]",
        anchor === "bottom-left"
          ? "expanding-panel-anchor-bottom-left"
          : "expanding-panel-anchor-bottom-right",
        open && "expanding-panel-surface-open",
        className
      )}
      aria-hidden={!open}
      style={{
        // A long streaming response can make the natural-content floor taller
        // than the native window. Keep the floor within the same viewport cap
        // as max-height so the middle flex child shrinks and becomes scrollable.
        minHeight: heightFloor === null ? undefined : `min(${heightFloor}px, calc(100% - 1.5rem))`,
        ...style,
      }}
      {...props}
    >
      {children}
    </section>
  );
}

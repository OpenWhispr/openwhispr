import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/utils";

interface ExpandingPanelShellProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  open: boolean;
  anchor?: "bottom-left" | "bottom-right";
  stabilizeHeight?: boolean;
  animateHeight?: boolean;
  measurementKey?: string | null;
  onPreferredHeightChange?: (height: number) => void;
  children: ReactNode;
}

/** Shared surface for pill-to-panel transitions; callers own only their inner layout. */
export function ExpandingPanelShell({
  open,
  anchor = "bottom-right",
  stabilizeHeight = false,
  animateHeight = false,
  measurementKey = null,
  onPreferredHeightChange,
  children,
  className,
  style,
  ...props
}: ExpandingPanelShellProps) {
  const shellRef = useRef<HTMLElement | null>(null);
  const lastPreferredHeightRef = useRef(0);
  const heightFloorRef = useRef(0);
  const heightCapRef = useRef(0);
  const [heightFloor, setHeightFloor] = useState<number | null>(null);

  useLayoutEffect(() => {
    lastPreferredHeightRef.current = 0;
    heightFloorRef.current = 0;
    // Voice modes mount only after the native window has grown to its maximum
    // responsive assistant footprint. Preserve that ceiling while the native
    // window later shrinks to content; using the current viewport as the cap
    // would prevent the panel from ever growing again.
    heightCapRef.current = Math.max(0, window.innerHeight - 24);
    setHeightFloor(null);
  }, [measurementKey]);

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
    if (!shell || !open || (!onPreferredHeightChange && !animateHeight)) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      // All spacing belongs inside the shell's direct flex children, so their
      // box metrics are enough here. Avoid getComputedStyle on every transcript
      // update: it synchronously flushes style calculation before layout reads.
      let preferredHeight = shell.offsetHeight - shell.clientHeight;

      for (const child of Array.from(shell.children)) {
        if (!(child instanceof HTMLElement)) continue;
        preferredHeight += Math.max(child.offsetHeight, child.scrollHeight);
      }

      // The shell has a 12px outer gutter on each side. Once the available
      // height is reached, the middle flex child owns scrolling and further
      // transcript lines must not keep changing the panel target.
      preferredHeight = Math.min(Math.ceil(preferredHeight), heightCapRef.current);
      if (stabilizeHeight && preferredHeight > heightFloorRef.current) {
        heightFloorRef.current = preferredHeight;
        setHeightFloor(preferredHeight);
      }

      const reportedHeight = stabilizeHeight
        ? Math.max(preferredHeight, heightFloorRef.current)
        : preferredHeight;
      if (Math.abs(reportedHeight - lastPreferredHeightRef.current) < 1) return;
      lastPreferredHeightRef.current = reportedHeight;
      onPreferredHeightChange?.(reportedHeight);
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    const observeSizeSources = () => {
      for (const source of shell.querySelectorAll("[data-panel-size-source]")) {
        resizeObserver.observe(source);
      }
    };

    if (!animateHeight) {
      resizeObserver.observe(shell);
      for (const child of Array.from(shell.children)) resizeObserver.observe(child);
    }
    observeSizeSources();

    // React normally updates transcript text through characterData mutations.
    // The observed size source already reports the only mutations relevant to
    // panel geometry: actual line-height changes. Watch child replacement only
    // so a mode/content swap can register its new size source.
    const mutationObserver = new MutationObserver(() => {
      observeSizeSources();
      scheduleMeasure();
    });
    mutationObserver.observe(shell, { childList: true, subtree: true });
    scheduleMeasure();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [animateHeight, onPreferredHeightChange, open, stabilizeHeight, measurementKey]);

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
      data-panel-height-animated={animateHeight ? "true" : undefined}
      style={{
        // A long streaming response can make the natural-content floor taller
        // than the native window. Keep the floor within the same viewport cap
        // as max-height so the middle flex child shrinks and becomes scrollable.
        height: animateHeight && heightFloor !== null ? `${heightFloor}px` : undefined,
        minHeight:
          !animateHeight && heightFloor !== null
            ? `min(${heightFloor}px, calc(100% - 1.5rem))`
            : undefined,
        ...style,
      }}
      {...props}
    >
      {children}
    </section>
  );
}

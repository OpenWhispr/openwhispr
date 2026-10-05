import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/utils";

interface ExpandingPanelShellProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  open: boolean;
  anchor?: "bottom-left" | "bottom-right";
  stabilizeHeight?: boolean;
  fillAvailableHeight?: boolean;
  preferredHeightCap?: number;
  measurementKey?: string | null;
  measurementRevision?: string | number | null;
  onPreferredHeightChange?: (
    height: number,
    measurementRevision?: string | number | null
  ) => void | Promise<unknown>;
  children: ReactNode;
}

/** Shared surface for pill-to-panel transitions; callers own only their inner layout. */
export function ExpandingPanelShell({
  open,
  anchor = "bottom-right",
  stabilizeHeight = false,
  fillAvailableHeight = false,
  preferredHeightCap,
  measurementKey = null,
  measurementRevision = null,
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
  const lastMeasurementRevisionRef = useRef<string | number | null>(null);
  const [heightFloor, setHeightFloor] = useState<number | null>(null);

  useLayoutEffect(() => {
    lastPreferredHeightRef.current = 0;
    heightFloorRef.current = 0;
    // Adaptive modes can enter in a compact native window. Preserve their
    // configured ceiling so content measurement can grow that window again;
    // otherwise the initial compact viewport becomes an accidental hard cap.
    heightCapRef.current = Math.max(0, preferredHeightCap ?? window.innerHeight - 24);
    lastMeasurementRevisionRef.current = null;
    setHeightFloor(null);
  }, [measurementKey, preferredHeightCap]);

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
    if (!shell || !open || !onPreferredHeightChange) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      // All spacing belongs inside the shell's direct flex children, so their
      // box metrics are enough here. Avoid getComputedStyle on every transcript
      // update: it synchronously flushes style calculation before layout reads.
      let preferredHeight = shell.offsetHeight - shell.clientHeight;
      const detachedSizeSource = Array.from(shell.children).find(
        (child) => child instanceof HTMLElement && child.hasAttribute("data-panel-size-source")
      ) as HTMLElement | undefined;

      for (const child of Array.from(shell.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child === detachedSizeSource) continue;
        if (child.hasAttribute("data-panel-scroll-region") && detachedSizeSource) {
          preferredHeight += Math.max(
            child.offsetHeight,
            detachedSizeSource.offsetHeight,
            detachedSizeSource.scrollHeight
          );
          continue;
        }
        preferredHeight += Math.max(child.offsetHeight, child.scrollHeight);
      }

      // The shell has a 12px outer gutter on each side. Once the available
      // height is reached, the middle flex child owns scrolling and further
      // transcript lines must not keep changing the panel target.
      preferredHeight = Math.min(Math.ceil(preferredHeight), heightCapRef.current);
      const reportedHeight = stabilizeHeight
        ? Math.max(preferredHeight, heightFloorRef.current)
        : preferredHeight;
      const revisionChanged = measurementRevision !== lastMeasurementRevisionRef.current;
      if (Math.abs(reportedHeight - lastPreferredHeightRef.current) < 1 && !revisionChanged) return;
      lastPreferredHeightRef.current = reportedHeight;
      lastMeasurementRevisionRef.current = measurementRevision;
      const resize = onPreferredHeightChange(reportedHeight, measurementRevision);
      if (stabilizeHeight && preferredHeight > heightFloorRef.current) {
        // The DOM already contains the natural height. Install its persistent
        // floor only after the native window has caught up, so CSS and Electron
        // never animate the same vertical change at the same time.
        void Promise.resolve(resize).then(() => {
          if (!shell.isConnected) return;
          heightFloorRef.current = Math.max(heightFloorRef.current, preferredHeight);
          setHeightFloor(heightFloorRef.current);
        });
      }
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

    resizeObserver.observe(shell);
    for (const child of Array.from(shell.children)) resizeObserver.observe(child);
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
  }, [onPreferredHeightChange, open, stabilizeHeight, measurementKey, measurementRevision]);

  return (
    <section
      ref={shellRef}
      className={cn(
        "expanding-panel-surface absolute inset-x-3 bottom-3 flex max-h-[calc(100%-1.5rem)] flex-col overflow-hidden",
        fillAvailableHeight ? "h-[calc(100%-1.5rem)]" : "h-fit",
        "rounded-3xl border border-border/50 bg-surface-0",
        "shadow-[var(--shadow-modal)]",
        anchor === "bottom-left"
          ? "expanding-panel-anchor-bottom-left"
          : "expanding-panel-anchor-bottom-right",
        open && "expanding-panel-surface-open",
        className
      )}
      aria-hidden={!open}
      data-panel-height-stabilized={stabilizeHeight ? "true" : undefined}
      style={{
        // A long streaming response can make the natural-content floor taller
        // than the native window. Keep the floor within the same viewport cap
        // as max-height so the middle flex child shrinks and becomes scrollable.
        height: heightFloor !== null ? `min(${heightFloor}px, calc(100% - 1.5rem))` : undefined,
        ...style,
      }}
      {...props}
    >
      {children}
    </section>
  );
}

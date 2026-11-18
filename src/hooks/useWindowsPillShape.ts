import { useLayoutEffect, useRef, type RefObject } from "react";
import type { MainWindowInputRegion } from "../types/electron";

interface WindowsPillShapeOptions {
  pillRef: RefObject<HTMLElement | null>;
  captureWindow: boolean;
  pillInteractive: boolean;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Room for the Signal glow, which paints outside the pill's layout box.
const SHAPE_PAD_PX = 12;
// Subpixel layout noise is not movement.
const MOVEMENT_EPSILON_PX = 0.5;
const STILL_FRAMES = 2;
// A transition barely moves on its first frame, so a wake-up watches a few.
const WATCH_FRAMES = 3;
const SAMPLE_INTERVAL_MS = 50;
const WAKE_EVENTS = ["transitionrun", "animationstart", "resize"] as const;

function measurePill(element: HTMLElement): Box | null {
  let box: Box | null = null;
  for (const node of [element, ...element.querySelectorAll("*")]) {
    const { left, top, right, bottom } = node.getBoundingClientRect();
    if (right <= left || bottom <= top) continue;
    box = box
      ? {
          left: Math.min(box.left, left),
          top: Math.min(box.top, top),
          right: Math.max(box.right, right),
          bottom: Math.max(box.bottom, bottom),
        }
      : { left, top, right, bottom };
  }
  if (!box) return null;
  const padded = {
    left: Math.max(0, box.left - SHAPE_PAD_PX),
    top: Math.max(0, box.top - SHAPE_PAD_PX),
    right: Math.min(window.innerWidth, box.right + SHAPE_PAD_PX),
    bottom: Math.min(window.innerHeight, box.bottom + SHAPE_PAD_PX),
  };
  // A resize mask can carry the pill out of the viewport for a few frames.
  return padded.right > padded.left && padded.bottom > padded.top ? padded : null;
}

function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.left - b.left) < MOVEMENT_EPSILON_PX &&
    Math.abs(a.top - b.top) < MOVEMENT_EPSILON_PX &&
    Math.abs(a.right - b.right) < MOVEMENT_EPSILON_PX &&
    Math.abs(a.bottom - b.bottom) < MOVEMENT_EPSILON_PX
  );
}

function regionOf(box: Box | null): MainWindowInputRegion {
  return {
    x: box?.left ?? 0,
    y: box?.top ?? 0,
    width: box ? box.right - box.left : 0,
    height: box ? box.bottom - box.top : 0,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

// The transparent dictation window is much larger than the pill, so Windows
// shapes it to the pill to let clicks around it through (#3152). The shape is
// SetWindowRgn, which clips painting as well as clicks, so it covers every
// descendant (tooltip, cancel control) and is only applied while the pill holds
// still. While anything moves or grows, the whole window stays.
export function useWindowsPillShape({
  pillRef,
  captureWindow,
  pillInteractive,
}: WindowsPillShapeOptions): void {
  const nativeVisibleRef = useRef(true);
  useLayoutEffect(() => {
    const api = window.electronAPI;
    if (api?.getPlatform?.() !== "win32") return;
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let frame = 0;
    let watchFrames = 0;
    let stillFrames = 0;
    let moving = false;
    let lastBox: Box | null = null;
    let observer: MutationObserver | undefined;

    const send = (region: MainWindowInputRegion | null): void => {
      const requestGeneration = generation;
      api.setMainWindowInputRegion(region).then(
        (visible) => {
          if (visible || disposed || requestGeneration !== generation) return;
          nativeVisibleRef.current = false;
          stop();
        },
        () => {
          if (!disposed && requestGeneration === generation) stop();
        }
      );
    };

    // The interval resends a still shape so main can repair it after a resize;
    // animation frames only send changes.
    const sample = (resend: boolean): void => {
      if (disposed || !nativeVisibleRef.current || document.hidden) return;
      const element = pillRef.current;
      const box = element ? measurePill(element) : null;
      if (!sameBox(box, lastBox)) {
        lastBox = box;
        stillFrames = 0;
        if (!moving) {
          moving = true;
          send(null);
        }
      } else if (moving && ++stillFrames >= STILL_FRAMES) {
        moving = false;
        watchFrames = 0;
        resend = true;
      }
      if (moving) watch();
      else if (resend) send(regionOf(box));
    };

    const onFrame = (): void => {
      frame = 0;
      sample(false);
      if (!frame && --watchFrames > 0) frame = requestAnimationFrame(onFrame);
    };

    const watch = (): void => {
      watchFrames = WATCH_FRAMES;
      if (!frame) frame = requestAnimationFrame(onFrame);
    };

    // A DOM change paints in the frame that commits it (a tooltip, a snapped
    // grow), so measure before that paint, not a frame later.
    const onMutation = (): void => {
      sample(false);
      watch();
    };

    const stop = (): void => {
      generation += 1;
      clearInterval(timer);
      timer = undefined;
      cancelAnimationFrame(frame);
      frame = 0;
      observer?.disconnect();
      observer = undefined;
      for (const type of WAKE_EVENTS) window.removeEventListener(type, watch, true);
    };

    const start = (): void => {
      stop();
      if (!nativeVisibleRef.current) return;
      if (captureWindow || !pillInteractive) {
        send(null);
        return;
      }
      lastBox = null;
      moving = false;
      observer = new MutationObserver(onMutation);
      observer.observe(document.documentElement, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      for (const type of WAKE_EVENTS) window.addEventListener(type, watch, true);
      timer = setInterval(() => sample(true), SAMPLE_INTERVAL_MS);
      sample(true);
    };

    const unsubscribe = api.onMainWindowVisibilityChanged((visible) => {
      nativeVisibleRef.current = visible;
      if (visible) start();
      else stop();
    });
    start();
    return () => {
      disposed = true;
      stop();
      unsubscribe();
      void api.setMainWindowInputRegion(null).catch(() => {});
    };
  }, [captureWindow, pillInteractive, pillRef]);
}

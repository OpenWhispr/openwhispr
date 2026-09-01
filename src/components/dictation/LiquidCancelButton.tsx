import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/utils";
import { emergenceBlend, traceFusedOutline } from "./liquidFusion";
import type { VoicePillState } from "./VoicePill";
import { LISTENING_ENTRANCE_TIMING, VOICE_PILL_CANCEL } from "../../helpers/voicePillPresentation";

const { size: CANCEL_BUTTON_SIZE, gap: CANCEL_BUTTON_GAP } = VOICE_PILL_CANCEL;
const EMERGENCE_MS = 280;
// The pill's chrome fade (VoicePill's inline 220ms background/border/shadow
// transition, mirrored by .liquid-cancel-skin's fill/stroke) — change together.
const CHROME_HANDOFF_MS = 220;

// cubic-bezier(0.2, 0, 0, 1) — the house motion curve, solved numerically so
// this rAF-driven emergence matches the CSS transitions around it.
function houseEase(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let u = x;
  for (let i = 0; i < 24; i++) {
    const inv = 1 - u;
    const bx = 0.6 * u * inv * inv + u * u * u;
    if (bx < x) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  const inv = 1 - u;
  return 3 * inv * u * u + u * u * u;
}

/** Drives the cancel button's emergence progress: 0 = swallowed by the pill,
 *  1 = at rest beside it. Reversing mid-flight resumes from the current value. */
function useCancelEmergence(visible: boolean): number {
  const [t, setT] = useState(visible ? 1 : 0);
  const raf = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const target = visible ? 1 : 0;
    const from = tRef.current;
    if (from === target) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const duration = reduced ? 1 : EMERGENCE_MS * Math.abs(target - from);
    let start = 0;
    const step = (now: number) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / duration);
      setT(from + (target - from) * houseEase(p));
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [visible]);

  return t;
}

/** Chases the pill footprint contract with the pill's own width/height
 *  transition (VOICE_PILL_GROW_TRANSITION: expansionMs on the house curve),
 *  so the skin never snaps while the real pill is mid-flight between
 *  footprints — the entrance's logo hold → compact expansion and the
 *  compact → thinking collapse at stop. It keeps chasing even while the skin
 *  is hidden so an emergence that starts mid-flight picks up the pill's
 *  current in-between size. Reduced motion snaps: the global reduced-motion
 *  rule drops width/height from transition-property, so the pill snaps too. */
function usePillFootprintTween(width: number, height: number): { w: number; h: number } {
  const [size, setSize] = useState({ w: width, h: height });
  const raf = useRef(0);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    const from = sizeRef.current;
    if (from.w === width && from.h === height) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      setSize({ w: width, h: height });
      return;
    }
    let start = 0;
    const step = (now: number) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / LISTENING_ENTRANCE_TIMING.expansionMs);
      const e = houseEase(p);
      setSize({ w: from.w + (width - from.w) * e, h: from.h + (height - from.h) * e });
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [width, height]);

  return size;
}

interface LiquidCancelButtonProps {
  visible: boolean;
  /** Fused mode draws the liquid skin and the pill goes headless; plain mode
   *  (inside the Live Transcript panel, where the pill is already headless)
   *  keeps the classic bordered circle and only animates scale/fade. */
  fused: boolean;
  /** Footprint targets, not rendered sizes: the pill transitions between the
   *  footprints and the skin tweens its geometry to match (usePillFootprintTween). */
  pillWidth: number;
  pillHeight: number;
  /** The pill state the skin replaces; keys the skin's stroke/fill to the
   *  pill's own chrome via .liquid-cancel-skin[data-pill-state] CSS. */
  pillState: VoicePillState;
  ariaLabel: string;
  onCancel: () => void;
  /** Fires when the fused skin starts/stops owning the pill surface, so the
   *  pill can go headless without the parent re-rendering every rAF frame. */
  onFusedSkinChange?: (active: boolean) => void;
}

export function LiquidCancelButton({
  visible,
  fused,
  pillWidth,
  pillHeight,
  pillState,
  ariaLabel,
  onCancel,
  onFusedSkinChange,
}: LiquidCancelButtonProps) {
  // The 60fps emergence lives here so only this leaf re-renders per frame.
  const t = useCancelEmergence(visible);
  const pillSize = usePillFootprintTween(pillWidth, pillHeight);
  const skinActive = fused && t > 0;
  const [skinLingers, setSkinLingers] = useState(false);
  const notifyRef = useRef(onFusedSkinChange);
  notifyRef.current = onFusedSkinChange;
  const skinWasActiveRef = useRef(false);
  useLayoutEffect(() => {
    notifyRef.current?.(skinActive);
    const wasActive = skinWasActiveRef.current;
    skinWasActiveRef.current = skinActive;
    if (skinActive) {
      setSkinLingers(false);
      return undefined;
    }
    if (!wasActive) return undefined;
    // Releasing the surface fades the pill's own chrome back in over
    // CHROME_HANDOFF_MS. The swallowed skin (t=0) is geometry-identical to
    // the bare pill, so keep painting it underneath until that fade lands —
    // unmounting it mid-fade dips the capsule to the faded chrome. (Fuse-in
    // is masked the same way for free: the skin mounts under the pill's
    // still-painted chrome as it fades out.)
    setSkinLingers(true);
    const timer = setTimeout(() => setSkinLingers(false), CHROME_HANDOFF_MS + 40);
    return () => clearTimeout(timer);
  }, [skinActive]);

  const slotWidth = t * (CANCEL_BUTTON_GAP + CANCEL_BUTTON_SIZE);
  // The absolute button overlaps the pill until its slot is at least one button wide.
  const buttonInteractive = visible && slotWidth >= CANCEL_BUTTON_SIZE;
  const showSkin = skinActive || (fused && skinLingers);
  const outline = useMemo(() => {
    if (!showSkin) return null;
    return traceFusedOutline(
      {
        pill: { w: pillSize.w, h: pillSize.h },
        circle: {
          cx: pillSize.w + slotWidth - CANCEL_BUTTON_SIZE / 2,
          cy: pillSize.h / 2,
          r: CANCEL_BUTTON_SIZE / 2,
        },
      },
      { k: emergenceBlend(t) }
    );
  }, [showSkin, t, pillSize, slotWidth]);

  if (t <= 0 && !skinLingers) return null;

  return (
    <div className="relative shrink-0" style={{ width: slotWidth, height: CANCEL_BUTTON_SIZE }}>
      {outline && (
        <svg
          aria-hidden="true"
          className="liquid-cancel-skin absolute"
          data-pill-state={pillState}
          viewBox={`${outline.minX} ${outline.minY} ${outline.width} ${outline.height}`}
          style={{
            left: outline.minX - pillSize.w,
            top: outline.minY - (pillSize.h - CANCEL_BUTTON_SIZE) / 2,
            width: outline.width,
            height: outline.height,
            zIndex: -1,
          }}
        >
          <path d={outline.d} strokeWidth="1" />
        </svg>
      )}
      <button
        type="button"
        aria-label={ariaLabel}
        aria-hidden={!buttonInteractive || undefined}
        disabled={!buttonInteractive}
        tabIndex={buttonInteractive ? undefined : -1}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
        className={cn(
          "absolute right-0 top-0 flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          !fused && "border border-border/55 bg-surface-2 shadow-sm hover:bg-surface-3",
          !buttonInteractive && "pointer-events-none"
        )}
        style={{
          // The glyph surfaces once the bud is mostly out; plain mode just
          // scales in with the slot.
          opacity: fused ? Math.max(0, (t - 0.35) / 0.65) : t,
          transform: fused ? undefined : `scale(${t})`,
        }}
      >
        <X size={13} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </div>
  );
}

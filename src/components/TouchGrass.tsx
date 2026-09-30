import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { cn } from "./lib/utils";
import type { GrassRustle } from "../utils/grassRustle";
import "../styles/touch-grass.css";

// The lawn is one flat field from the bottom of the scene to the horizon, drawn as a
// grid of patches: rows by depth, a few columns across. Only the patches animate
// (growth, breeze), so the GPU moves about a hundred textures a frame; the tufts
// inside them are painted once, and repainted only while the hand parts them.
const HORIZON = 48; // % of the scene from the bottom
const ROWS = 16;
const SEGMENTS = 6;
// When the breeze starts, just after the lawn has grown; each column then joins a
// little after the one to its left, so gusts roll across the lawn.
const WAVE_START_S = 3;
const WAVE_CROSSING_S = 1.2;
// Tufts part within this distance of the hand, fading to nothing at the edge.
const PART_RADIUS_PX = 64;
const MAX_PART_DEG = 40;
// How quickly a parted tuft follows its target, and springs back once the hand leaves.
const PART_EASE_MS = 90;
const KEY_STEP_PX = 18;
// The hand only rustles the grass below this fraction of the scene's height.
const LAWN_TOP = 1 - HORIZON / 100;

interface Tuft {
  x: number; // % across its patch
  lift: number; // px above the patch baseline, so rows don't read as stripes
  h: number; // px
  w: number; // px
  blades: string; // clip-path cutting the tuft into blades
  lean: number;
  bend: number;
  shade: number; // colour class, darker 0 to lighter 5
}

interface Patch {
  row: number;
  segment: number;
  y: number; // % from the bottom of the scene
  height: number; // px, the tallest tuft
  amp: number;
  growDelay: number;
  growDur: number;
  swayDur: number;
  swayDelay: number;
  tufts: Tuft[];
}

// Seeded so the patch is the same every visit; only the growth replays.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A tuft's blades as one polygon: each blade rises from the middle of the box along a
// curved centreline and tapers to its tip, so blades bend and lean like real grass
// instead of standing as straight spikes. Tips stay inside the box, where the
// background paints.
function bladesClipPath(rand: () => number): string {
  const count = 4 + Math.floor(rand() * 3);
  const cell = 60 / count;
  const point = (x: number, y: number) => `${x.toFixed(1)}% ${y.toFixed(1)}%`;
  const along = [0, 0.35, 0.65, 0.88];
  const points: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = 20 + cell * (i + 0.5) + (rand() - 0.5) * cell * 0.4;
    const halfWidth = cell * (0.28 + rand() * 0.14);
    const tipY = rand() * 35;
    const drift = (rand() - 0.5) * 36;
    const centre = (t: number) => base + drift * t * t;
    const height = (t: number) => 100 - (100 - tipY) * t;
    for (const t of along) points.push(point(centre(t) - halfWidth * (1 - t) ** 0.8, height(t)));
    points.push(point(centre(1), tipY));
    for (const t of [...along].reverse()) {
      points.push(point(centre(t) + halfWidth * (1 - t) ** 0.8, height(t)));
    }
  }
  return `polygon(${points.join(", ")})`;
}

// Rows crowd together toward the horizon, as they would in perspective.
function rowY(depth: number): number {
  return -4 + (HORIZON + 3) * (1 - (1 - depth) ** 1.8);
}

function makePatches(sceneHeight: number): Patch[] {
  const rand = mulberry32(0x9e3779b9);
  const patches: Patch[] = [];
  // Far rows first, so nearer rows paint over them.
  for (let row = ROWS - 1; row >= 0; row--) {
    // 0 is the front edge, 1 the horizon.
    const depth = row / (ROWS - 1);
    const scale = 1 - depth * 0.82;
    const y = rowY(depth);
    const rowGapPx = ((rowY(Math.min(1, depth + 1 / (ROWS - 1))) - y) / 100) * sceneHeight;
    // Smaller tufts need more of them to cover the ground.
    const tuftCount = Math.round(5 + depth * 9);
    for (let segment = 0; segment < SEGMENTS; segment++) {
      const tufts: Tuft[] = [];
      for (let i = 0; i < tuftCount; i++) {
        tufts.push({
          x: rand() * 100,
          // About one row's spacing, so neighbouring rows interleave. The breeze skews
          // from the patch baseline, which moves a lifted root by under a pixel.
          lift: rand() * rowGapPx,
          h: (40 + rand() * 20) * scale,
          w: (16 + rand() * 8) * (0.35 + scale * 0.65),
          blades: bladesClipPath(rand),
          lean: (rand() - 0.5) * 8,
          bend: (rand() - 0.5) * 14,
          // Farther rows are lighter, as distance washes colour out.
          shade: Math.min(5, Math.floor(depth * 2.2 + rand() * 3.8)),
        });
      }
      // Lower tufts paint over higher ones.
      tufts.sort((a, b) => b.lift - a.lift);
      patches.push({
        row,
        segment,
        y,
        height: Math.max(...tufts.map((tuft) => tuft.h)),
        // Negative skew pushes the tips right, with the gusts rolling left to right.
        amp: -(5 + rand() * 4),
        growDelay: depth * 0.5 + rand() * 0.8,
        growDur: 1.5 + rand() * 0.5,
        // Close periods keep the wave coherent; the small spread lets it drift so the
        // patches never lock into step.
        swayDur: 3.4 + rand() * 0.8,
        swayDelay:
          WAVE_START_S + (segment / SEGMENTS) * WAVE_CROSSING_S + depth * 0.3 + rand() * 0.25,
        tufts,
      });
    }
  }
  return patches;
}

function patchStyle(patch: Patch): CSSProperties {
  return {
    left: `${(patch.segment * 100) / SEGMENTS}%`,
    width: `${100 / SEGMENTS}%`,
    bottom: `${patch.y}%`,
    height: `${patch.height}px`,
    "--amp": `${patch.amp}deg`,
    "--grow-delay": `${patch.growDelay}s`,
    "--grow-dur": `${patch.growDur}s`,
    "--sway-dur": `${patch.swayDur}s`,
    "--sway-delay": `${patch.swayDelay}s`,
  } as CSSProperties;
}

// Plain values rather than custom properties: parting restyles tufts every frame, and
// var() would make each restyle re-substitute and re-parse the clip path and colours.
function tuftStyle(tuft: Tuft): CSSProperties {
  return {
    left: `${tuft.x}%`,
    bottom: `${tuft.lift}px`,
    width: `${tuft.w}px`,
    height: `${tuft.h}px`,
    marginLeft: `${-tuft.w / 2}px`,
    clipPath: tuft.blades,
    rotate: `${tuft.lean}deg`,
    transform: `skewX(${tuft.bend}deg)`,
  };
}

interface TouchGrassProps {
  rustle: GrassRustle;
  /** Height of the content this scene replaces, so the card keeps its size. */
  height: number;
  label: string;
  onExit: () => void;
}

type Hand = { x: number; y: number } | null;

export default function TouchGrass({ rustle, height, label, onExit }: TouchGrassProps) {
  // The measured height sizes the gaps between rows; the card keeps it for the visit.
  const patches = useMemo(() => makePatches(height || 240), [height]);
  // Every tuft's root as fractions of the scene (lift aside), in the same order as the DOM.
  const roots = useMemo(
    () =>
      patches.flatMap((patch) =>
        patch.tufts.map((tuft) => ({
          x: (patch.segment + tuft.x / 100) / SEGMENTS,
          y: patch.y / 100,
          h: tuft.h,
          lean: tuft.lean,
        }))
      ),
    [patches]
  );

  const sceneRef = useRef<HTMLDivElement>(null);
  const sceneRectRef = useRef<DOMRect | null>(null);
  const tuftNodesRef = useRef<HTMLElement[]>([]);
  const partRef = useRef(new Float32Array(roots.length));
  const partTargetRef = useRef(new Float32Array(roots.length));
  const frameRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const lastPointRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const keyHandRef = useRef<Hand>(null);

  useLayoutEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    tuftNodesRef.current = Array.from(scene.querySelectorAll<HTMLElement>("[data-tuft]"));
    scene.focus({ preventScroll: true });
  }, []);

  // The lawn rests while the window is in the background. The control panel never reports
  // itself hidden (backgroundThrottling is off, so visibilitychange doesn't fire and the
  // animations keep running when it goes to the tray), but it does lose focus.
  const [resting, setResting] = useState(false);

  useEffect(() => {
    const rest = () => {
      rustle.hush();
      setResting(true);
    };
    const wake = () => setResting(false);
    // The page can scroll or resize under a resting hand; measure again on the next move.
    const forgetRect = () => {
      sceneRectRef.current = null;
    };
    window.addEventListener("blur", rest);
    window.addEventListener("focus", wake);
    window.addEventListener("scroll", forgetRect, true);
    window.addEventListener("resize", forgetRect);
    return () => {
      window.removeEventListener("blur", rest);
      window.removeEventListener("focus", wake);
      window.removeEventListener("scroll", forgetRect, true);
      window.removeEventListener("resize", forgetRect);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [rustle]);

  const sceneRect = () => {
    sceneRectRef.current ??= sceneRef.current?.getBoundingClientRect() ?? null;
    return sceneRectRef.current;
  };

  // Eases each tuft toward its target lean and stops once every tuft has settled.
  const stepParting = (now: number) => {
    const ease = 1 - Math.exp(-(now - lastFrameRef.current) / PART_EASE_MS);
    lastFrameRef.current = now;
    const parts = partRef.current;
    const targets = partTargetRef.current;
    const nodes = tuftNodesRef.current;
    let settling = false;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === targets[i]) continue;
      let next = parts[i] + (targets[i] - parts[i]) * ease;
      if (Math.abs(targets[i] - next) < 0.1) next = targets[i];
      else settling = true;
      parts[i] = next;
      const node = nodes[i];
      if (node) node.style.rotate = `${(roots[i].lean + next).toFixed(1)}deg`;
    }
    frameRef.current = settling ? requestAnimationFrame(stepParting) : null;
  };

  // Tufts near the hand lean away from it; the rest spring back upright.
  const moveHand = (hand: Hand) => {
    const rect = sceneRect();
    const targets = partTargetRef.current;
    roots.forEach((root, i) => {
      let target = 0;
      if (hand && rect) {
        const rootX = root.x * rect.width;
        const middleY = rect.height * (1 - root.y) - root.h * 0.6;
        const distance = Math.hypot(rootX - hand.x, (middleY - hand.y) * 1.2);
        if (distance < PART_RADIUS_PX) {
          const strength = (1 - distance / PART_RADIUS_PX) ** 1.4;
          target = Math.sign(rootX - hand.x || 1) * strength * MAX_PART_DEG;
        }
      }
      targets[i] = target;
    });
    if (frameRef.current === null) {
      lastFrameRef.current = performance.now();
      frameRef.current = requestAnimationFrame(stepParting);
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = sceneRect();
    if (!rect) return;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const last = lastPointRef.current;
    if (last && y > rect.height * LAWN_TOP) {
      const speed = Math.hypot(x - last.x, y - last.y) / Math.max(event.timeStamp - last.t, 1);
      if (speed > 0.05) rustle.brush(speed);
    }
    lastPointRef.current = { x, y, t: event.timeStamp };
    moveHand({ x, y });
  };

  const handlePointerLeave = () => {
    lastPointRef.current = null;
    moveHand(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onExit();
      return;
    }
    const step = {
      ArrowLeft: [-KEY_STEP_PX, 0],
      ArrowRight: [KEY_STEP_PX, 0],
      ArrowUp: [0, -KEY_STEP_PX],
      ArrowDown: [0, KEY_STEP_PX],
    }[event.key];
    const rect = sceneRect();
    if (!step || !rect) return;
    event.preventDefault();
    const current = keyHandRef.current ?? { x: rect.width / 2, y: rect.height * 0.8 };
    const next = {
      x: Math.min(rect.width, Math.max(0, current.x + step[0])),
      y: Math.min(rect.height, Math.max(rect.height * LAWN_TOP, current.y + step[1])),
    };
    keyHandRef.current = next;
    rustle.brush(0.8);
    moveHand(next);
  };

  const handleBlur = () => {
    keyHandRef.current = null;
    moveHand(null);
  };

  return (
    <div
      ref={sceneRef}
      role="application"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "touch-grass -mx-2 rounded-t-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
        resting && "touch-grass--resting"
      )}
      style={{ height: height || undefined }}
      onPointerEnter={() => {
        sceneRectRef.current = null;
      }}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerLeave}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
    >
      <div className="touch-grass__ground" style={{ height: `${HORIZON}%` }} />
      {patches.map((patch) => (
        <div
          key={`${patch.row}-${patch.segment}`}
          className="touch-grass__patch"
          style={patchStyle(patch)}
        >
          {patch.tufts.map((tuft, i) => (
            <span
              key={i}
              data-tuft
              className={`touch-grass__tuft touch-grass__tuft--${tuft.shade}`}
              style={tuftStyle(tuft)}
            />
          ))}
        </div>
      ))}
      <div className="touch-grass__gust" style={{ height: `${HORIZON}%` }} />
    </div>
  );
}

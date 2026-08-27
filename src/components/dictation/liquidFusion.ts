// Minimal liquid-fusion geometry for the pill's cancel button: the smooth-union
// of two signed-distance fields traced into one SVG path. Extracted from the
// "Liquid UI" engine (sdRoundBox + smin + marching squares); only what the
// cancel emergence needs survives — two fixed shapes, one outline, no engine.
//
// Convention: the field is negative inside a shape, 0 on the surface, positive
// outside. The fused outline is the iso-contour at 0. `smin` is the fillet
// maker: k=0 is a hard union (sharp seam); larger k blends the fields near the
// seam into the concave neck that makes the button read as poured out of the
// pill.

interface Pt {
  x: number;
  y: number;
}

export interface FusionShapes {
  /** Pill rect at (0,0)..(w,h), radius h/2 (the rounded-full capsule). */
  pill: { w: number; h: number };
  /** Cancel circle center + radius, in the same space. */
  circle: { cx: number; cy: number; r: number };
}

export interface FusionOptions {
  /** Blend distance (px). Sized so the resting 8px pill↔button gap keeps a neck. */
  k?: number;
  /** Marching-squares grid step (px). */
  cell?: number;
  /** Chaikin smoothing passes on the traced loops. */
  smooth?: number;
}

export const CANCEL_FUSION_DEFAULTS: Required<FusionOptions> = {
  k: 24,
  cell: 2,
  smooth: 3,
};

/** Blend ramp for the cancel emergence. smin bulges up to ~k/4 outside a hard
 *  union, so a constant k would pop the skin 6px past the bare pill the moment
 *  it mounts. A smoothstep from a hard union (t=0, skin ≡ pill) to the full
 *  fillet keeps the handoff seamless and grows the neck gradually as the bud
 *  pushes out — a linear ramp reads as a step mid-flight. */
export function emergenceBlend(t: number, k = CANCEL_FUSION_DEFAULTS.k): number {
  const c = Math.max(0, Math.min(1, t));
  return k * c * c * (3 - 2 * c);
}

function sdRoundBox(
  px: number,
  py: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  r: number
): number {
  const rr = Math.min(r, Math.min(hw, hh));
  const qx = Math.abs(px - cx) - hw + rr;
  const qy = Math.abs(py - cy) - hh + rr;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - rr;
}

export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

function fieldEval(s: FusionShapes, k: number, x: number, y: number): number {
  const { pill, circle } = s;
  const dPill = sdRoundBox(x, y, pill.w / 2, pill.h / 2, pill.w / 2, pill.h / 2, pill.h / 2);
  const dCircle = Math.hypot(x - circle.cx, y - circle.cy) - circle.r;
  return smin(dPill, dCircle, k);
}

// Marching-squares edge table: for each 4-corner inside/outside mask, the cell
// edges the contour crosses. Edges: 0=top, 1=right, 2=bottom, 3=left. Corner
// bits: 8=TL, 4=TR, 2=BR, 1=BL (set = inside). Saddles (5, 10) are resolved by
// the cell-center sign at trace time.
const SADDLE_TL_BR: number[][] = [
  [3, 0],
  [2, 1],
];
const SADDLE_TR_BL: number[][] = [
  [3, 2],
  [0, 1],
];
const EDGES: number[][][] = [
  [],
  [[3, 2]],
  [[2, 1]],
  [[3, 1]],
  [[0, 1]],
  SADDLE_TR_BL,
  [[0, 2]],
  [[3, 0]],
  [[3, 0]],
  [[0, 2]],
  SADDLE_TL_BR,
  [[0, 1]],
  [[3, 1]],
  [[2, 1]],
  [[3, 2]],
  [],
];

function lerpEdge(x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): Pt {
  const denom = v0 - v1;
  const t = Math.abs(denom) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, v0 / denom));
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
}

function stitch(segs: [Pt, Pt][], cell: number): Pt[][] {
  const eps = cell * 0.5;
  const key = (p: Pt) => `${Math.round(p.x / eps)},${Math.round(p.y / eps)}`;
  const map = new Map<string, { seg: number; end: 0 | 1 }[]>();
  segs.forEach((s, idx) => {
    for (const end of [0, 1] as const) {
      const k = key(s[end]);
      const arr = map.get(k);
      if (arr) arr.push({ seg: idx, end });
      else map.set(k, [{ seg: idx, end }]);
    }
  });

  const used = new Array(segs.length).fill(false);
  const loops: Pt[][] = [];
  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    const loop: Pt[] = [];
    let cur = start;
    let end: 0 | 1 = 0;
    let guard = 0;
    while (!used[cur] && guard++ < segs.length + 2) {
      used[cur] = true;
      loop.push(segs[cur][end]);
      const other = segs[cur][end === 0 ? 1 : 0];
      const next = (map.get(key(other)) ?? []).find((c) => !used[c.seg]);
      if (!next) break;
      cur = next.seg;
      end = next.end;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function chaikin(pts: Pt[], passes: number): Pt[] {
  let out = pts;
  for (let p = 0; p < passes; p++) {
    const next: Pt[] = [];
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const a = out[i];
      const b = out[(i + 1) % n];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out = next;
  }
  return out;
}

export interface FusedOutline {
  d: string;
  minX: number;
  minY: number;
  width: number;
  height: number;
  /** Disconnected islands in the outline (1 while the neck holds). */
  loops: number;
}

/** Trace the fused pill+circle outline into one SVG path. Coordinates are in
 *  the pill's own space (pill top-left at 0,0); bounds are padded by k so the
 *  fillet bulge is never clipped. */
export function traceFusedOutline(shapes: FusionShapes, opts: FusionOptions = {}): FusedOutline {
  const { k, cell, smooth } = { ...CANCEL_FUSION_DEFAULTS, ...opts };
  const pad = k + cell;
  const minX = Math.min(0, shapes.circle.cx - shapes.circle.r) - pad;
  const minY = Math.min(0, shapes.circle.cy - shapes.circle.r) - pad;
  const maxX = Math.max(shapes.pill.w, shapes.circle.cx + shapes.circle.r) + pad;
  const maxY = Math.max(shapes.pill.h, shapes.circle.cy + shapes.circle.r) + pad;

  const cols = Math.ceil((maxX - minX) / cell) + 1;
  const rows = Math.ceil((maxY - minY) / cell) + 1;
  const val = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y = minY + j * cell;
    for (let i = 0; i < cols; i++) {
      val[j * cols + i] = fieldEval(shapes, k, minX + i * cell, y);
    }
  }

  const segs: [Pt, Pt][] = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const vTL = val[j * cols + i];
      const vTR = val[j * cols + i + 1];
      const vBR = val[(j + 1) * cols + i + 1];
      const vBL = val[(j + 1) * cols + i];
      let mask = 0;
      if (vTL < 0) mask |= 8;
      if (vTR < 0) mask |= 4;
      if (vBR < 0) mask |= 2;
      if (vBL < 0) mask |= 1;
      if (mask === 0 || mask === 15) continue;

      const x0 = minX + i * cell;
      const y0 = minY + j * cell;
      const x1 = x0 + cell;
      const y1 = y0 + cell;
      const edgePt = (edge: number): Pt => {
        switch (edge) {
          case 0:
            return lerpEdge(x0, y0, vTL, x1, y0, vTR);
          case 1:
            return lerpEdge(x1, y0, vTR, x1, y1, vBR);
          case 2:
            return lerpEdge(x0, y1, vBL, x1, y1, vBR);
          default:
            return lerpEdge(x0, y0, vTL, x0, y1, vBL);
        }
      };

      let cases = EDGES[mask];
      if (mask === 5 || mask === 10) {
        const centerInside = fieldEval(shapes, k, (x0 + x1) / 2, (y0 + y1) / 2) < 0;
        cases = (mask === 5) === centerInside ? SADDLE_TL_BR : SADDLE_TR_BL;
      }
      for (const [ea, eb] of cases) segs.push([edgePt(ea), edgePt(eb)]);
    }
  }

  const loops = stitch(segs, cell);
  const fmt = (v: number) => v.toFixed(2);
  const parts: string[] = [];
  for (const loop of loops) {
    const s = smooth > 0 ? chaikin(loop, smooth) : loop;
    if (s.length < 3) continue;
    parts.push(
      `M ${fmt(s[0].x)} ${fmt(s[0].y)} ` +
        s
          .slice(1)
          .map((p) => `L ${fmt(p.x)} ${fmt(p.y)}`)
          .join(" ") +
        " Z"
    );
  }

  return {
    d: parts.join(" "),
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY,
    loops: parts.length,
  };
}

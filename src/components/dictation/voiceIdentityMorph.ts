type CubicCurve = readonly [number, number, number, number, number, number];

interface CubicPath {
  start: readonly [number, number];
  curves: readonly CubicCurve[];
  closed?: boolean;
}

interface MorphPair {
  from: CubicPath;
  to: CubicPath;
}

const LISTENING_RING: CubicPath = {
  start: [4.929, 19.071],
  curves: [
    [1.024, 15.166, 1.024, 8.834, 4.929, 4.929],
    [8.834, 1.024, 15.166, 1.024, 19.071, 4.929],
    [22.976, 8.834, 22.976, 15.166, 19.071, 19.071],
    [15.166, 22.976, 8.834, 22.976, 4.929, 19.071],
  ],
  closed: true,
};

const AGENT_LEAF_CONTOUR: CubicPath = {
  start: [6.1, 19.8],
  curves: [
    [7.2, 13, 10.8, 6.1, 20.4, 5.1],
    [19.7, 7.5, 18.9, 10.1, 17.3, 11.5],
    [15.5, 13.2, 13.2, 14.3, 10.4, 14.8],
    [8.3, 15.1, 7.2, 17.1, 6.1, 19.8],
  ],
  closed: true,
};

const MORPH_PATHS = {
  shell: { from: LISTENING_RING, to: AGENT_LEAF_CONTOUR },
  leftBar: {
    from: { start: [8.75, 10], curves: [[8.75, 11.2, 8.75, 12.8, 8.75, 14]] },
    to: { start: [4.7, 7.1], curves: [[5.8, 7.1, 7.1, 7.1, 8.3, 7.1]] },
  },
  centerBar: {
    from: { start: [12, 8], curves: [[12, 10.2, 12, 13.8, 12, 16]] },
    to: { start: [6.4, 19], curves: [[9.1, 13.2, 13.6, 8.2, 19.4, 5.5]] },
  },
  rightBar: {
    from: { start: [15.25, 10], curves: [[15.25, 11.2, 15.25, 12.8, 15.25, 14]] },
    to: { start: [10.3, 14], curves: [[12.2, 14, 14.8, 12.3, 16.8, 9.7]] },
  },
  sparkCross: {
    from: { start: [8.75, 10], curves: [[8.75, 11.2, 8.75, 12.8, 8.75, 14]] },
    to: { start: [6.5, 5.2], curves: [[6.5, 6.3, 6.5, 7.8, 6.5, 8.9]] },
  },
} satisfies Record<string, MorphPair>;

export const VOICE_IDENTITY_MORPH_DURATION_MS = 480;

const interpolate = (from: number, to: number, progress: number) => from + (to - from) * progress;

const format = (value: number) => Number(value.toFixed(3));

const interpolatePath = ({ from, to }: MorphPair, progress: number) => {
  const startX = format(interpolate(from.start[0], to.start[0], progress));
  const startY = format(interpolate(from.start[1], to.start[1], progress));
  const curves = from.curves.map((curve, curveIndex) => {
    const target = to.curves[curveIndex];
    const values = curve.map((value, valueIndex) =>
      format(interpolate(value, target[valueIndex], progress))
    );
    return `C${values.join(" ")}`;
  });
  return `M${startX} ${startY}${curves.join("")}${from.closed ? "Z" : ""}`;
};

const smoothRange = (progress: number, start: number, end: number) => {
  const normalized = Math.min(1, Math.max(0, (progress - start) / (end - start)));
  return normalized * normalized * (3 - 2 * normalized);
};

export const resolveVoiceIdentityMorphPaths = (progress: number) => {
  const boundedProgress = Math.min(1, Math.max(0, progress));
  return {
    shell: interpolatePath(MORPH_PATHS.shell, boundedProgress),
    leftBar: interpolatePath(MORPH_PATHS.leftBar, boundedProgress),
    centerBar: interpolatePath(MORPH_PATHS.centerBar, boundedProgress),
    rightBar: interpolatePath(MORPH_PATHS.rightBar, boundedProgress),
    sparkCross: interpolatePath(MORPH_PATHS.sparkCross, boundedProgress),
    constructionOpacity: 1 - smoothRange(boundedProgress, 0.7, 0.96),
    sparkOpacity:
      smoothRange(boundedProgress, 0.2, 0.48) * (1 - smoothRange(boundedProgress, 0.72, 0.96)),
    agentOpacity: smoothRange(boundedProgress, 0.58, 0.94),
  };
};

// The supplied sparkle/leaf Agent mark (20x20 viewBox, drawn with
// currentColor); the morph resolves toward this final identity.
export const AGENT_MODE_PATH =
  "M6.14226 7.53708L5.97827 7.8973C5.95264 7.95595 5.9094 8.00606 5.854 8.0413C5.7986 8.07654 5.73352 8.09535 5.66694 8.09535C5.60037 8.09535 5.53528 8.07654 5.47988 8.0413C5.42448 8.00606 5.38125 7.95595 5.35562 7.8973L5.19162 7.53708C4.90328 6.89985 4.37523 6.38893 3.71166 6.10514L3.20567 5.88939C3.14428 5.86244 3.09228 5.81924 3.05583 5.76493C3.01937 5.71062 3 5.64746 3 5.58296C3 5.51845 3.01937 5.4553 3.05583 5.40099C3.09228 5.34668 3.14428 5.30348 3.20567 5.27652L3.68366 5.0735C4.36391 4.78163 4.901 4.25181 5.18429 3.59319L5.35362 3.20434C5.37839 3.14411 5.42159 3.09239 5.4776 3.05595C5.53361 3.0195 5.59982 3 5.66761 3C5.73539 3 5.80161 3.0195 5.85761 3.05595C5.91362 3.09239 5.95683 3.14411 5.9816 3.20434L6.15026 3.59256C6.43325 4.2513 6.9701 4.78135 7.65023 5.0735L8.12888 5.27716C8.19008 5.30419 8.2419 5.34738 8.27821 5.40163C8.31453 5.45587 8.33383 5.5189 8.33383 5.58328C8.33383 5.64765 8.31453 5.71068 8.27821 5.76493C8.2419 5.81917 8.19008 5.86236 8.12888 5.88939L7.62223 6.1045C6.95879 6.38858 6.43097 6.89973 6.14293 7.53708M7.22357 13.0657C7.3409 12.6953 7.47223 12.328 7.62689 11.9316C8.99753 8.41407 11.2801 6.23497 15.0094 5.68319C14.6674 6.41062 14.3441 6.91657 14.0581 7.1896L13.3908 7.82729L12.4481 8.72846L13.4188 9.65381C12.6654 10.9807 11.1768 12.0372 9.50152 12.237C8.62354 12.342 7.86222 12.6233 7.2229 13.0663M15 9.36297L14.3334 8.72655L15.002 8.08822C15.6683 7.45138 16.3342 6.17918 17 4.27162C7.20757 4.27162 5.72627 12.8155 5.04296 16.7556L5.00029 17H6.33226C6.77625 14.8786 7.88778 13.7118 9.66684 13.4997C12.3334 13.1815 14.3334 11.2722 15 9.36297Z";

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

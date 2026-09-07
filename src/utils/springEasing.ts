// Springs as CSS linear() easings, generated once (no animation library).
// The curve is the closed-form damped spring from the design page's
// prototype, sampled over its natural settle time and played over the
// pinned duration below — the same trick the prototype uses for "show".

export function springLinearEasing(
  stiffness: number,
  damping: number,
  mass = 1,
  segments = 48
): string {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  let settleSeconds: number;
  let position: (t: number) => number;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    settleSeconds = -Math.log(0.001) / (zeta * w0);
    position = (t) =>
      1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  } else {
    settleSeconds = (-Math.log(0.001) / w0) * 1.6;
    position = (t) => 1 - (1 + w0 * t) * Math.exp(-w0 * t);
  }
  const points: string[] = [];
  for (let i = 0; i <= segments; i++) {
    const progress = i / segments;
    const value = i === segments ? 1 : position(progress * settleSeconds);
    points.push(`${value.toFixed(4)} ${(progress * 100).toFixed(1)}%`);
  }
  return `linear(${points.join(", ")})`;
}

export const MOTION_EASING = Object.freeze({
  morph: springLinearEasing(300, 26),
  show: springLinearEasing(380, 28),
  zoop: springLinearEasing(520, 46),
  word: springLinearEasing(420, 32),
});

export const MOTION_TIMING = Object.freeze({
  morphMs: 440,
  showMs: 260,
  zoopMs: 200,
  wordMs: 320,
  wordStaggerMs: 28,
  copyCrossfadeMs: 320,
  companionFadeMs: 160,
  closeFadeMs: 120,
  listeningExpansionMs: 360,
});

export function motionCssVariables(): Record<string, string> {
  return {
    "--motion-morph-ease": MOTION_EASING.morph,
    "--motion-morph-ms": `${MOTION_TIMING.morphMs}ms`,
    "--motion-show-ease": MOTION_EASING.show,
    "--motion-show-ms": `${MOTION_TIMING.showMs}ms`,
    "--motion-zoop-ease": MOTION_EASING.zoop,
    "--motion-zoop-ms": `${MOTION_TIMING.zoopMs}ms`,
    "--motion-word-ease": MOTION_EASING.word,
    "--motion-word-ms": `${MOTION_TIMING.wordMs}ms`,
    "--motion-word-stagger-ms": `${MOTION_TIMING.wordStaggerMs}ms`,
    "--motion-companion-fade-ms": `${MOTION_TIMING.companionFadeMs}ms`,
    "--motion-close-fade-ms": `${MOTION_TIMING.closeFadeMs}ms`,
  };
}

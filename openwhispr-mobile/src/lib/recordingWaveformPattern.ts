export const KEYBOARD_RECORDING_WAVEFORM = {
  barCount: 28,
  height: 84,
  barWidth: 3,
  barGap: 4,
  minScale: 0.08,
  minOpacity: 0.35,
  // Silence on a phone mic sits around -50 to -40 dBFS (room ambient), not the
  // -60 digital floor. Anchoring the floor at -50 and gating out everything
  // below ~-37 dB (noiseGate 0.26 of the range) lets the bars fall back to the
  // baseline during pauses; voice (-36 dB and up) still drives them.
  meteringMinDb: -50,
  noiseGate: 0.26,
  // Near-linear response (power ~1, no multiplier boost) so the bars track
  // loudness proportionally instead of slamming to full height on the faintest
  // sound past the gate. The gate already handles silence; emphasis only shapes
  // how voice maps to height.
  emphasisPower: 0.85,
  emphasisMultiplier: 1.0,
  attackCoefficient: 0.78,
  releaseCoefficient: 0.34,
  pollIntervalMs: 60,
} as const;

export function normalizeDbToKeyboardLevel(dbLevel: number): number {
  const { meteringMinDb } = KEYBOARD_RECORDING_WAVEFORM;
  const clampedDb = Math.max(meteringMinDb, Math.min(0, dbLevel));
  return Math.max(0, Math.min(1, (clampedDb - meteringMinDb) / (0 - meteringMinDb)));
}

export function smoothKeyboardRecordingLevel(level: number, previousLevel: number): number {
  const clamped = Math.max(0, Math.min(1, level));
  const gated = clamped < KEYBOARD_RECORDING_WAVEFORM.noiseGate ? 0 : clamped;
  const emphasized = Math.min(
    1,
    Math.pow(gated, KEYBOARD_RECORDING_WAVEFORM.emphasisPower) *
      KEYBOARD_RECORDING_WAVEFORM.emphasisMultiplier,
  );
  const smoothing =
    emphasized > previousLevel
      ? KEYBOARD_RECORDING_WAVEFORM.attackCoefficient
      : KEYBOARD_RECORDING_WAVEFORM.releaseCoefficient;

  return previousLevel + (emphasized - previousLevel) * smoothing;
}

export function meterLevelsForKeyboardBars(
  history: number[],
  barCount: number = KEYBOARD_RECORDING_WAVEFORM.barCount,
): number[] {
  if (barCount <= 0) return [];
  if (history.length === 0) return Array(barCount).fill(0);

  const recent = history.slice(-barCount);
  if (recent.length <= barCount) {
    return [...Array(barCount - recent.length).fill(0), ...recent];
  }

  return recent;
}

export function keyboardRecordingBarVisuals(level: number) {
  const value = Math.max(0, Math.min(1, level));
  return {
    scale:
      KEYBOARD_RECORDING_WAVEFORM.minScale + value * (1 - KEYBOARD_RECORDING_WAVEFORM.minScale),
    opacity:
      KEYBOARD_RECORDING_WAVEFORM.minOpacity + value * (1 - KEYBOARD_RECORDING_WAVEFORM.minOpacity),
  };
}

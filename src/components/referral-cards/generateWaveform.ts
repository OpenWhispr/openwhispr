/**
 * Generates a 2D spectrogram-like heatmap from a referral code.
 * Rows = frequency bands (low->high), Cols = time steps.
 * Each cell is a 0-1 intensity value.
 */
export function generateSpectrogramData(code: string, cols: number, rows: number): number[][] {
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    hash = ((hash << 5) - hash + code.charCodeAt(i)) | 0;
  }

  const seed = (offset: number) => {
    const h = ((hash + offset * 2654435761) | 0) >>> 0;
    return (h % 10000) / 10000;
  };

  // Formant peaks — horizontal bands of energy like speech
  const numFormants = 3 + Math.floor(seed(0) * 3);
  const formants = Array.from({ length: numFormants }, (_, f) => ({
    center: 1 + seed(f * 10 + 1) * (rows - 2),
    width: 0.8 + seed(f * 10 + 2) * 2,
    intensity: 0.3 + seed(f * 10 + 3) * 0.7,
    timeFreq: 0.5 + seed(f * 10 + 4) * 3,
    timePhase: seed(f * 10 + 5) * Math.PI * 2,
  }));

  // Time bursts — energy clusters like syllables
  const numBursts = 3 + Math.floor(seed(100) * 3);
  const bursts = Array.from({ length: numBursts }, (_, b) => ({
    center: 0.1 + seed(b * 5 + 101) * 0.8,
    width: 0.05 + seed(b * 5 + 102) * 0.15,
    intensity: 0.5 + seed(b * 5 + 103) * 0.5,
  }));

  const data: number[][] = [];
  for (let row = 0; row < rows; row++) {
    const rowData: number[] = [];
    for (let col = 0; col < cols; col++) {
      let value = 0;
      const t = col / (cols - 1);

      // Noise floor
      value += seed(row * cols + col + 500) * 0.08;

      // Burst envelope
      let burstEnv = 0.15;
      for (const burst of bursts) {
        const dist = Math.abs(t - burst.center);
        burstEnv += burst.intensity * Math.exp(-(dist * dist) / (2 * burst.width * burst.width));
      }
      burstEnv = Math.min(1, burstEnv);

      // Formant contributions
      for (const f of formants) {
        const freqDist = Math.abs(row - f.center);
        const gaussian = Math.exp(-(freqDist * freqDist) / (2 * f.width * f.width));
        const timeMod = 0.4 + 0.6 * Math.sin(t * Math.PI * f.timeFreq * 2 + f.timePhase);
        value += gaussian * f.intensity * timeMod * burstEnv;
      }

      // High frequency rolloff
      const freqRolloff = 1 - (row / rows) * 0.5;

      // Edge fade
      const edgeFade = Math.min(t * 8, (1 - t) * 8, 1);

      const raw = Math.min(1, value * freqRolloff * edgeFade);
      rowData.push(Math.pow(raw, 0.75)); // contrast boost — brightens midtones
    }
    data.push(rowData);
  }

  return data;
}

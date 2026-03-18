import React, { useRef, useEffect, useCallback } from "react";

/**
 * Live audio waveform visualizer that reads from a Web Audio AnalyserNode.
 * Renders an SVG with animated frequency bars that respond to voice input.
 */
export const LiveWaveform = ({ getAnalyser, size = 24, barCount = 5, color = "white" }) => {
  const barsRef = useRef([]);
  const rafRef = useRef(null);
  const dataArrayRef = useRef(null);
  const smoothedRef = useRef(new Float32Array(barCount));

  const animate = useCallback(() => {
    const analyser = getAnalyser();
    if (!analyser) {
      rafRef.current = requestAnimationFrame(animate);
      return;
    }

    if (!dataArrayRef.current || dataArrayRef.current.length !== analyser.frequencyBinCount) {
      dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
    }

    analyser.getByteFrequencyData(dataArrayRef.current);
    const data = dataArrayRef.current;
    const binCount = data.length;

    // Voice-relevant range: bins 1-50 (~47Hz to ~9.4kHz at 48kHz with fftSize=256)
    const startBin = 1;
    const endBin = Math.min(50, binCount);
    const step = Math.max(1, Math.floor((endBin - startBin) / barCount));

    const smoothed = smoothedRef.current;

    for (let i = 0; i < barCount; i++) {
      const binStart = startBin + i * step;
      // Average several bins per bar for stability
      let sum = 0;
      for (let j = 0; j < step; j++) {
        sum += data[Math.min(binStart + j, binCount - 1)] || 0;
      }
      const raw = sum / step / 255; // normalize 0-1

      // Smooth: rise fast, fall slow
      const prev = smoothed[i] || 0;
      smoothed[i] = raw > prev ? prev + (raw - prev) * 0.6 : prev + (raw - prev) * 0.15;
      const value = smoothed[i];

      // Map to bar height: min 15%, max 90% of total height
      const barH = 0.15 + value * 0.75;

      if (barsRef.current[i]) {
        barsRef.current[i].setAttribute("height", `${barH * size}`);
        barsRef.current[i].setAttribute("y", `${(size - barH * size) / 2}`);
      }
    }

    rafRef.current = requestAnimationFrame(animate);
  }, [getAnalyser, size, barCount]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [animate]);

  const barWidth = size / (barCount * 2.2);
  const gap = (size - barWidth * barCount) / (barCount + 1);
  const radius = barWidth / 2;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {Array.from({ length: barCount }).map((_, i) => (
        <rect
          key={i}
          ref={(el) => { barsRef.current[i] = el; }}
          x={gap + i * (barWidth + gap)}
          y={size * 0.425}
          width={barWidth}
          height={size * 0.15}
          rx={radius}
          ry={radius}
          fill={color}
        />
      ))}
    </svg>
  );
};

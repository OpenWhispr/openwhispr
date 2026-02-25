import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { generateSpectrogramData } from "./generateWaveform";

interface SpectrogramCardProps {
  referralCode: string;
}

const COLS = 48;
const ROWS = 14;
const STEP = 9;
const CELL = 6;
const CELL_RADIUS = 1.2;
const SVG_W = COLS * STEP;
const SVG_H = ROWS * STEP;
const OFFSET = (STEP - CELL) / 2;
const DURATION = 2.5;

const NOISE_BG = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)" opacity="1"/></svg>'
)}")`;

const FREQ_MIN = 150;
const FREQ_MAX = 4000;
const FREQUENCIES = Array.from({ length: ROWS }, (_, i) => {
  const t = i / (ROWS - 1);
  return FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t);
});

function spectrogramColor(value: number): string {
  if (value < 0.05) return "transparent";
  const a = (0.1 + value * 0.8).toFixed(3);
  return `oklch(0.72 0.22 260 / ${a})`;
}

function createAudio(data: number[][]): { stop: () => void } | null {
  try {
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});

    const now = ctx.currentTime;
    const master = ctx.createGain();
    const lpf = ctx.createBiquadFilter();

    lpf.type = "lowpass";
    lpf.frequency.value = 3500;
    lpf.Q.value = 0.7;
    lpf.connect(master);
    master.connect(ctx.destination);

    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(0.15, now + 0.08);
    master.gain.setValueAtTime(0.15, now + DURATION - 0.15);
    master.gain.linearRampToValueAtTime(0, now + DURATION);

    const oscillators: OscillatorNode[] = [];

    for (let band = 0; band < ROWS; band++) {
      const osc = ctx.createOscillator();
      const bandGain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.value = FREQUENCIES[band];
      osc.detune.value = (Math.random() - 0.5) * 4;

      const row = data[band];
      if (!row) continue;
      bandGain.gain.setValueAtTime(0, now);
      for (let col = 0; col < row.length; col++) {
        const t = now + (col / (row.length - 1)) * DURATION;
        const val = (row[col] ?? 0) * 0.08;
        if (Number.isFinite(t) && Number.isFinite(val)) {
          bandGain.gain.linearRampToValueAtTime(val, t);
        }
      }
      bandGain.gain.linearRampToValueAtTime(0, now + DURATION);

      osc.connect(bandGain);
      bandGain.connect(lpf);
      osc.start(now);
      osc.stop(now + DURATION);
      oscillators.push(osc);
    }

    return {
      stop() {
        oscillators.forEach((o) => {
          try {
            o.stop();
          } catch {
            /* already stopped */
          }
        });
        ctx.close().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}

export function SpectrogramCard({ referralCode }: SpectrogramCardProps) {
  const { t } = useTranslation();
  const data = useMemo(() => generateSpectrogramData(referralCode, COLS, ROWS), [referralCode]);
  const [playing, setPlaying] = useState(false);
  const [playKey, setPlayKey] = useState(0);
  const audioRef = useRef<{ stop(): void } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasAutoPlayed = useRef(false);

  const resetPlayback = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    audioRef.current?.stop();
    audioRef.current = null;
    setPlaying(false);
  }, []);

  const play = useCallback(() => {
    audioRef.current?.stop();
    if (timerRef.current) clearTimeout(timerRef.current);

    setPlaying(true);
    setPlayKey((k) => k + 1);
    audioRef.current = createAudio(data);

    // Safety net — animationend on scan line is the primary reset
    timerRef.current = setTimeout(resetPlayback, DURATION * 1000 + 500);
  }, [data, resetPlayback]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      audioRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (hasAutoPlayed.current) return;
    hasAutoPlayed.current = true;
    const delay = setTimeout(() => play(), 200);
    return () => clearTimeout(delay);
  }, [play]);

  return (
    <div className="relative w-full h-55 rounded-lg border overflow-hidden bg-surface-1 border-border dark:border-foreground/6">
      {/* Noise texture */}
      <div
        className="absolute inset-0 rounded-lg opacity-[0.03] pointer-events-none mix-blend-overlay"
        style={{ backgroundImage: NOISE_BG, backgroundSize: "128px 128px" }}
      />

      {/* Brand + Signal ID */}
      <div className="absolute top-0 inset-x-0 px-5 pt-3.5 flex items-center justify-between z-10">
        <span className="text-xs font-medium uppercase tracking-[0.2em] text-foreground/20 select-none">
          {t("referral.card.brand")}
        </span>
        <div className="flex flex-col items-end">
          <span className="text-xs font-mono text-foreground/30 tracking-wider select-all">
            {referralCode}
          </span>
          <span className="text-[7px] uppercase tracking-[0.15em] text-foreground/12 select-none">
            {t("referral.card.signalId")}
          </span>
        </div>
      </div>

      {/* Spectrogram visualization */}
      <div className="absolute inset-x-5 top-11 bottom-17">
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="w-full h-full"
          preserveAspectRatio="none"
          aria-hidden
        >
          {data.map((row, y) =>
            row.map((value, x) =>
              value >= 0.05 ? (
                <rect
                  key={`${x}-${y}`}
                  x={x * STEP + OFFSET}
                  y={y * STEP + OFFSET}
                  width={CELL}
                  height={CELL}
                  rx={CELL_RADIUS}
                  fill={spectrogramColor(value)}
                />
              ) : null
            )
          )}
        </svg>

        {/* Playback scan line — onAnimationEnd resets play state */}
        {playing && (
          <div
            key={playKey}
            className="spectrogram-play absolute top-0 bottom-0 w-px pointer-events-none z-10"
            onAnimationEnd={resetPlayback}
            style={{
              background: "oklch(0.72 0.22 260)",
              boxShadow:
                "0 0 10px 3px oklch(0.72 0.22 260 / 0.5), 0 0 24px 6px oklch(0.72 0.22 260 / 0.2)",
              animationDuration: `${DURATION}s`,
            }}
          />
        )}
      </div>

      {/* Bottom content */}
      <div className="absolute bottom-0 inset-x-0 px-5 pb-4 z-10">
        <div className="flex items-end justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={playing ? resetPlayback : play}
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center transition-[background-color,color,transform] duration-200",
                "border border-foreground/10 active:scale-[0.93]",
                playing
                  ? "bg-foreground/12 text-foreground/80"
                  : "bg-foreground/6 text-foreground/40 hover:bg-foreground/10 hover:text-foreground/70"
              )}
              aria-label={playing ? t("referral.card.stop") : t("referral.card.playSignal")}
            >
              {playing ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <rect x="1" y="1" width="8" height="8" rx="1" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <polygon points="2,0.5 9.5,5 2,9.5" />
                </svg>
              )}
            </button>
            <div>
              <span className="text-xs font-medium text-foreground/70 leading-tight block">
                {t("referral.card.audioSignature")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

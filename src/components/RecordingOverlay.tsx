import React, { useEffect, useRef, useState, useCallback } from "react";
import "./RecordingOverlay.css";

const BUFFER_SIZE = 40;
const BAR_WIDTH = 3;
const BAR_GAP = 2;
const HIDE_DELAY_MS = 300;

export default function RecordingOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelsRef = useRef<number[]>(new Array(BUFFER_SIZE).fill(0));
  const animFrameRef = useRef<number>(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [visible, setVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const levels = levelsRef.current;
    const totalBarWidth = BUFFER_SIZE * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
    const startX = (w - totalBarWidth) / 2;
    const centerY = h / 2;
    const maxBarHeight = h * 0.8;

    for (let i = 0; i < BUFFER_SIZE; i++) {
      const level = levels[i];
      const barHeight = Math.max(2, level * maxBarHeight);
      const x = startX + i * (BAR_WIDTH + BAR_GAP);
      const y = centerY - barHeight / 2;

      ctx.fillStyle = isRecording
        ? `rgba(59, 130, 246, ${0.5 + level * 0.5})`
        : `rgba(147, 51, 234, ${0.5 + level * 0.5})`;
      ctx.beginPath();
      ctx.roundRect(x, y, BAR_WIDTH, barHeight, 1.5);
      ctx.fill();
    }

    animFrameRef.current = requestAnimationFrame(draw);
  }, [isRecording]);

  useEffect(() => {
    const cleanup = window.electronAPI?.onRecordingOverlayUpdate?.(
      (_event: unknown, data: { level: number; isRecording: boolean; isProcessing: boolean }) => {
        const { level, isRecording: rec, isProcessing: proc } = data;

        setIsRecording(rec);
        setIsProcessing(proc);

        // Push level into rolling buffer
        levelsRef.current.shift();
        levelsRef.current.push(Math.min(1, level * 3)); // amplify for visibility

        if (rec || proc) {
          if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
          }
          setVisible(true);
        } else {
          if (!hideTimerRef.current) {
            hideTimerRef.current = setTimeout(() => {
              setVisible(false);
              hideTimerRef.current = null;
            }, HIDE_DELAY_MS);
          }
        }
      }
    );

    return () => cleanup?.();
  }, []);

  // Start/stop animation loop
  useEffect(() => {
    if (visible) {
      animFrameRef.current = requestAnimationFrame(draw);
    } else {
      cancelAnimationFrame(animFrameRef.current);
    }
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [visible, draw]);

  const handleCancel = useCallback(() => {
    window.electronAPI?.cancelRecordingFromOverlay?.();
  }, []);

  if (!visible) {
    return <div className="recording-overlay-root" />;
  }

  return (
    <div className="recording-overlay-root">
      <div className="recording-overlay-pill">
        <canvas ref={canvasRef} className="recording-overlay-canvas" />
        <span className="recording-overlay-status">
          {isProcessing ? (
            <>
              <span className="recording-overlay-spinner" />
              Processing…
            </>
          ) : (
            "Recording…"
          )}
        </span>
        <button
          className="recording-overlay-cancel"
          onClick={handleCancel}
          aria-label="Cancel recording"
        >
          ×
        </button>
      </div>
    </div>
  );
}

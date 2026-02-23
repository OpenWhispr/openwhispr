import { useEffect, useRef, useCallback } from "react";
import logger from "../utils/logger";

const CHUNK_DURATION_MS = 3000;
const POLL_INTERVAL_MS = 5000;

/**
 * Captures audio from the microphone via MediaRecorder and sends chunks to the
 * main process for wake-word / finish-phrase detection.
 *
 * Uses a stop-start cycle instead of timeslice to ensure each chunk is a
 * complete, self-contained WebM file that FFmpeg can parse. Each cycle:
 *   1. Start recording
 *   2. After 3 seconds, stop recording
 *   3. Collect the complete blob (with proper WebM headers)
 *   4. Send to main process for transcription
 *   5. Start a new recording
 *
 * Polls wake word status periodically. When enabled, opens a MediaRecorder
 * and begins the capture cycle. Runs continuously regardless of dictation
 * state — during dictation it sends chunks for stop-word detection instead
 * of wake-word detection.
 */
export function useWakeWordCapture() {
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const pollRef = useRef(null);
  const cycleTimerRef = useRef(null);
  const isCapturingRef = useRef(false);
  const isStartingRef = useRef(false);
  const chunkCountRef = useRef(0);

  /**
   * Run one capture cycle: record for CHUNK_DURATION_MS, stop, send the
   * complete blob, then schedule the next cycle.
   */
  const runCycle = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !isCapturingRef.current) return;

    // Verify stream is still active
    const tracks = stream.getAudioTracks();
    if (!tracks.length || tracks[0].readyState !== "live") {
      console.warn("[WakeWord] Audio track ended, stopping capture");
      isCapturingRef.current = false;
      return;
    }

    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    const chunks = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onstop = async () => {
      recorderRef.current = null;
      if (!isCapturingRef.current) return; // capture was stopped externally

      if (chunks.length === 0) return;

      const blob = new Blob(chunks, { type: recorder.mimeType });
      chunkCountRef.current++;
      const chunkNum = chunkCountRef.current;

      if (blob.size > 1000) {
        try {
          const buf = await blob.arrayBuffer();
          console.log(`[WakeWord] Sending chunk #${chunkNum} (${blob.size} bytes, ${recorder.mimeType})`);
          const result = await window.electronAPI?.wakeWordCheckChunk?.(new Uint8Array(buf));
          if (result) {
            console.log(`[WakeWord] Chunk #${chunkNum} result:`, result.text || result.skipped || "(empty)");
          }
        } catch (err) {
          console.warn(`[WakeWord] Chunk #${chunkNum} send failed:`, err.message);
        }
      }

      // Schedule next cycle
      if (isCapturingRef.current) {
        cycleTimerRef.current = setTimeout(runCycle, 100);
      }
    };

    recorder.onerror = (event) => {
      console.error("[WakeWord] MediaRecorder error:", event.error?.message || event);
      recorderRef.current = null;
      // Try again after a delay
      if (isCapturingRef.current) {
        cycleTimerRef.current = setTimeout(runCycle, 1000);
      }
    };

    recorder.start();

    // Stop after CHUNK_DURATION_MS to produce a complete WebM file
    cycleTimerRef.current = setTimeout(() => {
      if (recorder.state === "recording") {
        recorder.stop();
      }
    }, CHUNK_DURATION_MS);
  }, []);

  const startCapture = useCallback(async () => {
    if (isCapturingRef.current || isStartingRef.current) return;
    isStartingRef.current = true;

    try {
      console.log("[WakeWord] Requesting microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("[WakeWord] Microphone access granted, starting capture cycle");
      streamRef.current = stream;
      isCapturingRef.current = true;
      chunkCountRef.current = 0;
      logger.info("Wake word capture started", {}, "audio");

      // Begin the first capture cycle
      runCycle();
    } catch (err) {
      console.error("[WakeWord] Failed to start capture:", err.message);
      logger.error("Wake word capture failed to start", { error: err.message }, "audio");
      isCapturingRef.current = false;
    } finally {
      isStartingRef.current = false;
    }
  }, [runCycle]);

  const stopCapture = useCallback(() => {
    isCapturingRef.current = false;
    isStartingRef.current = false;

    if (cycleTimerRef.current) {
      clearTimeout(cycleTimerRef.current);
      cycleTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state === "recording") {
      try {
        recorderRef.current.stop();
      } catch {}
    }
    recorderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    let alive = true;

    async function check() {
      if (!alive) return;

      let status;
      try {
        status = await window.electronAPI?.wakeWordStatus?.();
      } catch (err) {
        console.warn("[WakeWord] Status check failed:", err.message);
        return;
      }

      const shouldCapture = status?.enabled;

      if (shouldCapture && !isCapturingRef.current && !isStartingRef.current) {
        console.log("[WakeWord] Status: enabled, starting capture...");
        startCapture();
      } else if (!shouldCapture && isCapturingRef.current) {
        console.log("[WakeWord] Status: stopping capture (disabled)");
        stopCapture();
      }
    }

    check();
    pollRef.current = setInterval(check, POLL_INTERVAL_MS);

    return () => {
      alive = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      stopCapture();
    };
  }, [startCapture, stopCapture]);
}

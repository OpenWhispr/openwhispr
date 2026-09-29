export interface PcmPlayer {
  enqueue: (samples: Float32Array) => void;
  /** Stops everything queued or playing, immediately (barge-in), and un-pauses. */
  flush: () => void;
  /** Holds playback where it is; queued audio waits (the user may be talking over it). */
  pause: () => void;
  resume: () => void;
  isPlaying: () => boolean;
  close: () => Promise<void>;
}

interface PcmPlayerOptions {
  sampleRate: number;
  /** Fires when audio starts after silence. */
  onStart?: () => void;
  /** Fires when the queue drains. */
  onIdle?: () => void;
}

// Small lead so back-to-back chunks never schedule in the past.
const SCHEDULE_LEAD_S = 0.03;

/**
 * Gapless playback of streamed mono PCM chunks through Web Audio. Playing in the
 * renderer keeps the output inside Chromium, whose echo canceller then removes
 * it from the getUserMedia capture.
 */
export function createPcmPlayer({ sampleRate, onStart, onIdle }: PcmPlayerOptions): PcmPlayer {
  const context = new AudioContext({ sampleRate, latencyHint: "interactive" });
  const active = new Set<AudioBufferSourceNode>();
  let nextStartTime = 0;
  let paused = false;
  // A context closed mid-session (stop) rejects these; there is nothing left to play.
  const resume = () => {
    paused = false;
    context.resume().catch(() => {});
  };

  const handleEnded = (source: AudioBufferSourceNode) => {
    active.delete(source);
    if (active.size === 0) onIdle?.();
  };

  return {
    enqueue(samples) {
      if (samples.length === 0) return;
      if (!paused && context.state === "suspended") context.resume().catch(() => {});
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(new Float32Array(samples), 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => handleEnded(source);
      const startAt = Math.max(context.currentTime + SCHEDULE_LEAD_S, nextStartTime);
      if (active.size === 0) onStart?.();
      active.add(source);
      source.start(startAt);
      nextStartTime = startAt + buffer.duration;
    },
    flush() {
      for (const source of active) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Not started yet or already stopped.
        }
      }
      const hadAudio = active.size > 0;
      active.clear();
      nextStartTime = 0;
      if (paused) resume();
      if (hadAudio) onIdle?.();
    },
    pause() {
      paused = true;
      context.suspend().catch(() => {});
    },
    resume,
    isPlaying: () => active.size > 0,
    close: () => context.close(),
  };
}

// PCM16 mono at the native tap's 24kHz. Reuse bounded silence blocks even if
// recovery takes a long time; never allocate the entire missing interval.
const SAMPLE_RATE = 24000;
// Match normal 100ms tap delivery. Providers may prepend a pending partial
// packet, so a block at their maximum frame size would overflow that limit.
const SILENCE_SAMPLES = SAMPLE_RATE / 10;
const SILENCE = Buffer.alloc(SILENCE_SAMPLES * 2);

const createMeetingAudioTimeline = ({ now = () => performance.now(), wallNow = Date.now } = {}) => {
  let startedAt = null;
  let wallStartedAt = null;
  let samples = 0;
  let recovering = false;

  return {
    markRestart() {
      recovering = true;
    },
    write(buffer, emit) {
      const receivedAt = now();
      startedAt ??= receivedAt;
      wallStartedAt ??= wallNow();
      if (recovering) {
        // Repair only explicit capture restarts. Arrival jitter and buffered
        // delivery during normal capture must not manufacture gaps.
        const elapsedSamples = Math.round(((receivedAt - startedAt) * SAMPLE_RATE) / 1000);
        let missingSamples = Math.max(0, elapsedSamples - samples);
        while (missingSamples > 0) {
          const count = Math.min(missingSamples, SILENCE_SAMPLES);
          emit(
            SILENCE.subarray(0, count * 2),
            true,
            wallStartedAt + (samples * 1000) / SAMPLE_RATE
          );
          samples += count;
          missingSamples -= count;
        }
        recovering = false;
      }
      const capturedAt = wallStartedAt + (samples * 1000) / SAMPLE_RATE;
      samples += buffer.length / 2;
      emit(buffer, false, capturedAt);
    },
  };
};

module.exports = createMeetingAudioTimeline;

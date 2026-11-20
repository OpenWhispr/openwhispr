// A 24 kHz mono PCM16 meeting track carries 48 bytes per millisecond.
const captureStartFromDelivery = (buffer, deliveredAt) => deliveredAt - buffer.length / 48;

function createMeetingCaptureClock() {
  let bytes = 0;
  let firstSampleAt = null;
  let skippedMs = 0;
  const gaps = [];
  return {
    get firstSampleAt() {
      return firstSampleAt;
    },
    append(buffer, capturedAt) {
      firstSampleAt ??= capturedAt;
      const offsetMs = bytes / 48;
      const drift = capturedAt - (firstSampleAt + offsetMs + skippedMs);
      // A capture callback can arrive late. Align real discontinuities while
      // keeping ordinary sub-frame delivery jitter on the PCM sample clock.
      if (drift > 250) {
        skippedMs += drift;
        gaps.push({ offsetMs, skippedMs });
      }
      bytes += buffer.length;
    },
    elapsedMs(offsetMs, endExclusive = false) {
      // A window ending exactly where capture paused still belongs to the
      // earlier audio. A word starting there belongs to the resumed stream.
      const gap = gaps.findLast((point) =>
        endExclusive ? point.offsetMs < offsetMs : point.offsetMs <= offsetMs
      );
      return offsetMs + (gap?.skippedMs ?? 0);
    },
  };
}

module.exports = { captureStartFromDelivery, createMeetingCaptureClock };

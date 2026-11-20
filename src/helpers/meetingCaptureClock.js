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
      const observedSkip = capturedAt - firstSampleAt - offsetMs;
      if (observedSkip > skippedMs + 250) {
        skippedMs = observedSkip;
        gaps.push({ offsetMs, skippedMs });
      } else if (observedSkip < skippedMs) {
        // Delivery only gives an upper bound on capture time. After a stall,
        // consecutive reads can drain a backlog faster than realtime. Trim the
        // newest inferred gaps first so an earlier, real pause stays in place.
        skippedMs = Math.max(0, observedSkip);
        while (gaps.length && (gaps.at(-2)?.skippedMs ?? 0) >= skippedMs) gaps.pop();
        if (gaps.length) gaps.at(-1).skippedMs = skippedMs;
        if (observedSkip < 0) firstSampleAt += observedSkip;
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

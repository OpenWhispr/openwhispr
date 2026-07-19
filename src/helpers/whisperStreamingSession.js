// VAD-gated pseudo-streaming for whisper.cpp, with quality-gated adaptive merging.
//
// whisper.cpp has no incremental/streaming encoder: every /inference re-encodes
// the whole clip. The old dictation preview re-transcribed ALL accumulated audio
// on a fixed timer, so cost grew with clip length and the preview flickered
// (each pass overwrites the previous text). This session instead segments the
// live PCM by silence (energy VAD + hangover) and transcribes each closed
// utterance exactly once — committed text only ever grows, never rewrites, and
// per-inference cost is bounded by one utterance instead of the whole clip.
//
// Adaptive merging: a silence boundary is only a *hint*. If a closed utterance
// transcribes with low confidence (caller-supplied isLowQuality predicate over
// whisper's avg_logprob / compression_ratio / no_speech_prob), we do NOT commit
// it — we keep its PCM and prepend it to the next utterance, then re-transcribe
// the combined audio from scratch. More acoustic context is exactly what fixes
// short/ambiguous segments and repairs VAD cuts that split one thought in two.
// Merging is bounded (maxMerges / maxMergedMs): low confidence does not imply
// "will improve if merged" — some audio is just hard — so past the cap (or at
// finish) we commit best-effort instead of growing unbounded.
//
// Optionally, while an utterance is still open it can be re-transcribed as a
// volatile "partial" (via requestPartial()) so continuous, pauseless speech
// still shows text before the first silence boundary. Partials are best-effort
// and always yield to pending commits — whisper-server is a shared singleton, so
// only one inference may be in flight at a time.
//
// The session is deliberately free of Electron/whisper-server imports: it takes
// a `transcribe(pcm16Buffer) => Promise<string | {text, quality}>` callback,
// which keeps it unit testable with `node --test`. Input PCM must be 16 kHz mono
// signed 16-bit LE (what the renderer's preview worklet already produces).

const { DEFAULT_WHISPER_VAD_CONFIG } = require("./whisperVadConfig");

const STATE_SILENCE = "silence";
const STATE_SPEECH = "speech";

const DEFAULTS = Object.freeze({
  sampleRate: 16000,
  frameMs: 20,
  // Enter-speech RMS floor (0..1). A frame counts as voiced when its RMS clears
  // max(energyThreshold, noiseFloor * NOISE_FLOOR_FACTOR), so a noisy mic raises
  // the bar adaptively instead of latching on to steady background hum.
  // Kept low deliberately: this is an absolute floor, not scaled to the user's
  // configured mic gain, and it only ever matters in quiet rooms — in noisy ones
  // the adaptive noiseFloor * noiseFloorFactor term dominates regardless. Too high
  // a floor means real speech that the authoritative (non-VAD-gated) offline pass
  // transcribes just fine never even registers as "voiced" here, so the live
  // preview shows nothing; the rare frame that does cross a high floor is often
  // a truncated fragment (plosive/mic pop) that transcribes as garbage.
  energyThreshold: 0.006,
  // Segments whose overall RMS is below this are dropped without an inference —
  // guards against a VAD blip transcribing near-silence into a hallucination.
  minSegmentRms: 0.003,
  noiseFloorFactor: 3,
  noiseFloorAlpha: 0.05,
  // Adaptive-merge caps: how many times a low-quality utterance may be deferred
  // into the next one, and the hard ceiling on the merged audio length.
  maxMerges: 2,
  maxMergedMs: 20000,
});

function computeRms(buf, byteOffset, sampleCount) {
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const n = buf.readInt16LE(byteOffset + i * 2) / 0x8000;
    sumSq += n * n;
  }
  return sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0;
}

function bufferRms(buf) {
  return computeRms(buf, 0, Math.floor(buf.length / 2));
}

class WhisperVadStreamingSession {
  constructor(options = {}) {
    if (typeof options.transcribe !== "function") {
      throw new Error("WhisperVadStreamingSession requires a transcribe(pcm16Buffer) function");
    }
    const vad = { ...DEFAULT_WHISPER_VAD_CONFIG, ...(options.vadConfig || {}) };

    this._transcribe = options.transcribe;
    this._onCommit = options.onCommit || null;
    this._onPartial = options.onPartial || null;
    this._onError = options.onError || null;
    // (quality, { text, mergedMs, mergeCount }) => boolean. Absent => never
    // merge, so the session behaves as a plain one-shot-per-utterance segmenter.
    this._isLowQuality = typeof options.isLowQuality === "function" ? options.isLowQuality : null;

    this._sampleRate = options.sampleRate || DEFAULTS.sampleRate;
    this._frameMs = options.frameMs || DEFAULTS.frameMs;
    this._frameSamples = Math.round((this._sampleRate * this._frameMs) / 1000);
    this._frameBytes = this._frameSamples * 2;

    this._energyThreshold = options.energyThreshold ?? DEFAULTS.energyThreshold;
    this._minSegmentRms = options.minSegmentRms ?? DEFAULTS.minSegmentRms;
    this._noiseFloorFactor = options.noiseFloorFactor ?? DEFAULTS.noiseFloorFactor;
    this._noiseFloorAlpha = options.noiseFloorAlpha ?? DEFAULTS.noiseFloorAlpha;
    this._maxMerges = options.maxMerges ?? DEFAULTS.maxMerges;
    this._maxMergedMs = options.maxMergedMs ?? DEFAULTS.maxMergedMs;

    this._minSpeechMs = vad.minSpeechDurationMs;
    this._minSilenceMs = vad.minSilenceDurationMs;
    this._speechPadMs = vad.speechPadMs;
    this._maxSpeechMs = vad.maxSpeechDurationS * 1000;
    this._overlapSamples = Math.floor(vad.samplesOverlap * this._sampleRate);

    // Pre-roll holds recent frames during silence so a confirmed segment starts
    // with lead-in context (pad) plus the voiced buildup that triggered it.
    this._prerollCap = Math.ceil((this._speechPadMs + this._minSpeechMs) / this._frameMs);

    this._reset();
    this._noiseFloor = 0;

    this._carry = null; // odd trailing byte spanning two pushPcm16 calls
    this._acc = Buffer.alloc(0); // whole frames not yet processed

    this._queue = []; // closed-utterance audio buffers awaiting inference (FIFO)
    this._busy = false; // an inference (commit or partial) is in flight
    this._pumpPromise = null;
    this._committed = [];
    this._deferredAudio = null; // low-quality PCM held to merge into the next utterance
    this._mergeCount = 0;
    this._committedMs = 0; // total audio duration behind committed text
    this._lowQualityMs = 0; // committed audio duration still judged low confidence
    // Total duration of audio ever pushed in, regardless of whether the VAD ever
    // judged it "voiced". lowQualityRatio alone only scores what WAS committed —
    // if the VAD misses most of a long utterance but transcribes the one snippet
    // it does catch with high confidence, that ratio reads as perfect even though
    // most of the recording was silently dropped. Comparing committedMs against
    // this total is what actually catches that under-coverage case.
    this._totalInputMs = 0;
    this._aborted = false;
    this._finishing = false;
    this._hadError = false;
  }

  _reset() {
    this._state = STATE_SILENCE;
    this._seg = [];
    this._preroll = [];
    this._segMs = 0;
    this._silenceRunMs = 0;
    this._voicedRunMs = 0;
  }

  pushPcm16(input) {
    if (this._aborted || this._finishing) return;
    let buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (this._carry) {
      buf = Buffer.concat([this._carry, buf]);
      this._carry = null;
    }
    if (buf.length % 2 === 1) {
      this._carry = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
    }
    this._acc = this._acc.length ? Buffer.concat([this._acc, buf]) : buf;

    let off = 0;
    while (this._acc.length - off >= this._frameBytes) {
      this._processFrame(this._acc, off);
      off += this._frameBytes;
    }
    if (off > 0) this._acc = Buffer.from(this._acc.subarray(off));
  }

  _frameCopy(buf, byteOffset) {
    return Buffer.from(buf.subarray(byteOffset, byteOffset + this._frameBytes));
  }

  _processFrame(buf, byteOffset) {
    this._totalInputMs += this._frameMs;
    const rms = computeRms(buf, byteOffset, this._frameSamples);
    const bar = Math.max(this._energyThreshold, this._noiseFloor * this._noiseFloorFactor);
    const voiced = rms >= bar;

    if (this._state === STATE_SILENCE) {
      if (!voiced) {
        this._noiseFloor =
          (1 - this._noiseFloorAlpha) * this._noiseFloor + this._noiseFloorAlpha * rms;
      }
      this._preroll.push(this._frameCopy(buf, byteOffset));
      if (this._preroll.length > this._prerollCap) this._preroll.shift();

      if (voiced) {
        this._voicedRunMs += this._frameMs;
        if (this._voicedRunMs >= this._minSpeechMs) {
          // Speech confirmed — adopt the pre-roll (pad + buildup) as the segment head.
          this._state = STATE_SPEECH;
          this._seg = this._preroll.slice();
          this._preroll = [];
          this._segMs = this._seg.length * this._frameMs;
          this._silenceRunMs = 0;
          this._voicedRunMs = 0;
        }
      } else {
        this._voicedRunMs = 0;
      }
      return;
    }

    // STATE_SPEECH
    this._seg.push(this._frameCopy(buf, byteOffset));
    this._segMs += this._frameMs;

    if (voiced) {
      this._silenceRunMs = 0;
    } else {
      this._silenceRunMs += this._frameMs;
      if (this._silenceRunMs >= this._minSilenceMs) {
        this._flushSegment();
        return;
      }
    }

    if (this._segMs >= this._maxSpeechMs) {
      // Utterance ran past the cap without a pause; commit what we have and keep
      // listening, carrying a short overlap so a word straddling the cut survives.
      this._flushSegment({ keepSpeaking: true });
    }
  }

  _flushSegment({ keepSpeaking = false } = {}) {
    const segBuf = this._seg.length ? Buffer.concat(this._seg) : Buffer.alloc(0);

    if (keepSpeaking) {
      const overlapBytes = this._overlapSamples * 2;
      const tail =
        segBuf.length > overlapBytes
          ? Buffer.from(segBuf.subarray(segBuf.length - overlapBytes))
          : Buffer.from(segBuf);
      this._seg = tail.length ? [tail] : [];
      this._segMs = Math.round((tail.length / 2 / this._sampleRate) * 1000);
      this._silenceRunMs = 0;
    } else {
      this._reset();
    }

    if (segBuf.length && bufferRms(segBuf) >= this._minSegmentRms) {
      this._queue.push(segBuf);
      this._pump();
    }
  }

  async _run(pcmBuffer) {
    const result = await this._transcribe(pcmBuffer);
    if (typeof result === "string") return { text: result, quality: null };
    return { text: (result && result.text) || "", quality: (result && result.quality) ?? null };
  }

  _bufferMs(buf) {
    return (buf.length / 2 / this._sampleRate) * 1000;
  }

  // Best-effort re-transcription of the currently open utterance (with any
  // deferred low-quality audio prepended, so the preview matches the eventual
  // commit). Skips when an inference is running or commits are queued — commits
  // always win, so a partial never delays the authoritative committed text.
  requestPartial() {
    if (this._aborted || this._finishing) return;
    if (!this._onPartial) return;
    if (this._busy || this._queue.length) return;
    if (this._state !== STATE_SPEECH || !this._seg.length) return;

    const openBuf = Buffer.concat(this._seg);
    const combined = this._deferredAudio
      ? Buffer.concat([this._deferredAudio, openBuf])
      : openBuf;
    if (bufferRms(combined) < this._minSegmentRms) return;

    this._busy = true;
    this._pumpPromise = (async () => {
      try {
        const { text } = await this._run(combined);
        if (!this._aborted && !this._finishing && this._onPartial) {
          this._onPartial((text || "").trim());
        }
      } catch (err) {
        this._hadError = true;
        this._onError?.(err);
      } finally {
        this._busy = false;
        this._pump();
      }
    })();
  }

  _pump() {
    if (this._busy || this._aborted) return;
    if (this._queue.length === 0) return;
    const audioBuf = this._queue.shift();

    this._busy = true;
    this._pumpPromise = (async () => {
      try {
        const combined = this._deferredAudio
          ? Buffer.concat([this._deferredAudio, audioBuf])
          : audioBuf;
        const { text, quality } = await this._run(combined);
        const trimmed = (text || "").trim();
        const combinedMs = this._bufferMs(combined);
        const capHit = this._mergeCount >= this._maxMerges || combinedMs >= this._maxMergedMs;
        // Raw quality verdict, independent of the merge guards — used both to
        // decide deferral AND to tally how much committed audio ended up being
        // low confidence (so callers can reject a globally poor stream).
        const qualityLow =
          !!this._isLowQuality &&
          this._isLowQuality(quality, {
            text: trimmed,
            mergedMs: combinedMs,
            mergeCount: this._mergeCount,
          });
        // Deferral needs somewhere to merge forward: another utterance still in
        // flight, or more speech yet to come. Once finishing with an empty queue
        // this is the last chunk, so commit it best-effort instead of holding it.
        const hasNext = !this._finishing || this._queue.length > 0;
        const defer = qualityLow && hasNext && !capHit;

        if (defer) {
          // Hold this audio and roll it into the next utterance for more context.
          this._deferredAudio = combined;
          this._mergeCount += 1;
          if (!this._aborted && trimmed) this._onPartial?.(trimmed);
        } else {
          this._deferredAudio = null;
          this._mergeCount = 0;
          if (!this._aborted && trimmed) {
            this._committed.push(trimmed);
            this._committedMs += combinedMs;
            // Committed despite low confidence (cap hit / no next / finishing).
            if (qualityLow) this._lowQualityMs += combinedMs;
            this._onCommit?.(trimmed, { index: this._committed.length - 1 });
          }
        }
      } catch (err) {
        // Don't strand deferred audio on error — drop it so finish() converges.
        this._deferredAudio = null;
        this._mergeCount = 0;
        this._hadError = true;
        this._onError?.(err);
      } finally {
        this._busy = false;
        this._pump();
      }
    })();
  }

  getCommittedText() {
    return this._committed.join(" ").trim();
  }

  // Flush the open utterance and wait for every queued/in-flight inference to
  // finish. In finishing mode nothing is deferred (there is no "next" utterance
  // to merge into), so a held low-quality tail is committed best-effort. The
  // returned `finalized` flag is true only when no inference errored and the
  // session was not aborted — callers can use it to gate a streamed fast-path.
  async finish() {
    this._finishing = true;
    if (this._state === STATE_SPEECH && this._seg.length) this._flushSegment();

    while (this._queue.length || this._busy || this._deferredAudio) {
      if (this._deferredAudio && this._queue.length === 0 && !this._busy) {
        // No following utterance arrived — force a final pump to flush the tail.
        this._queue.push(Buffer.alloc(0));
      }
      this._pump();
      if (this._pumpPromise) {
        await this._pumpPromise.catch(() => {});
      }
    }

    return {
      text: this.getCommittedText(),
      segments: this._committed.slice(),
      finalized: !this._hadError && !this._aborted,
      quality: {
        committedMs: this._committedMs,
        lowQualityMs: this._lowQualityMs,
        totalInputMs: this._totalInputMs,
        // Fraction (0..1) of committed audio duration that stayed low confidence
        // even after any merging. High => the stream is globally poor; callers
        // should prefer a full offline re-transcription over this transcript.
        lowQualityRatio: this._committedMs > 0 ? this._lowQualityMs / this._committedMs : 0,
        // Fraction (0..1) of the whole session's audio that ended up committed.
        // Low => the VAD missed most of the recording (never entered STATE_SPEECH,
        // or flushed segments too quiet to clear minSegmentRms), even if the sliver
        // it did catch transcribed with perfect confidence. Callers should treat
        // this the same as low confidence: prefer the authoritative offline pass.
        coverageRatio: this._totalInputMs > 0 ? this._committedMs / this._totalInputMs : 0,
      },
    };
  }

  abort() {
    this._aborted = true;
    this._queue = [];
    this._deferredAudio = null;
    this._mergeCount = 0;
    this._reset();
  }
}

function createWhisperVadStreamingSession(options) {
  return new WhisperVadStreamingSession(options);
}

module.exports = {
  createWhisperVadStreamingSession,
  WhisperVadStreamingSession,
  computeRms,
  bufferRms,
};

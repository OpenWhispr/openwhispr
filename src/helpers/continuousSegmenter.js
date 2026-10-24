// Cuts a continuous 16 kHz PCM16 mic stream into spoken phrases for continuous
// dictation. A pause of `phrasePauseMs` ends a phrase (`onSegment`, which the
// session transcribes and pastes, then reports with `phraseSettled()`); speech
// that runs on is cut into chunks at gaps between words, so text keeps landing
// while the user talks. Once
// every phrase has settled, `submitSilenceMs` of silence ends the message
// (`onSubmit`, which presses Enter). The countdown runs from the later of the
// last speech and the last phrase landing, so the user gets the whole wait
// after seeing their text, however long transcription took. Pure: time is
// counted in samples, so tests drive it with generated PCM.

export const CONTINUOUS_SAMPLE_RATE = 16000;

export const CONTINUOUS_SUBMIT_SILENCE_CHOICES_MS = [3000, 5000, 7000, 10000, 15000];
export const DEFAULT_CONTINUOUS_SUBMIT_SILENCE_MS = 3000;

// Snaps a stored silence to the nearest offered choice, so a value saved by an
// earlier build or edited by hand still works; anything unreadable takes the default.
export function snapContinuousSubmitSilenceMs(value) {
  if (!Number.isFinite(value)) return DEFAULT_CONTINUOUS_SUBMIT_SILENCE_MS;
  return CONTINUOUS_SUBMIT_SILENCE_CHOICES_MS.reduce((best, choice) =>
    Math.abs(choice - value) < Math.abs(best - value) ? choice : best
  );
}

export const CONTINUOUS_SEGMENTER_DEFAULTS = {
  // A pause this long ends a phrase, so text lands soon after the user stops.
  phrasePauseMs: 1000,
  // While the user keeps talking, a chunk is cut at the next gap between words
  // once it is this long, so text keeps arriving every few seconds...
  chunkTargetMs: 2500,
  // ...and at the quietest moment of its last 1.5 s if no gap comes by this length.
  chunkMaxMs: 6000,
  // Silence kept after a phrase's last word; the rest of the pause is trimmed,
  // since whisper tends to invent words ("Thank you.") in long silences.
  trailingKeepMs: 300,
  submitSilenceMs: DEFAULT_CONTINUOUS_SUBMIT_SILENCE_MS,
  // Audio kept from before speech was confirmed, so the first syllable survives.
  preRollMs: 300,
  // Shorter bursts (a click, a cough, a chair) are dropped instead of being
  // sent to a model that would invent words for them.
  minSpeechMs: 250,
  // Consecutive speech frames needed to open a phrase.
  speechStartFrames: 2,
  // Absolute floors under the adaptive thresholds (RMS of samples in -1..1).
  minSpeechRms: 0.008,
  minSilenceRms: 0.005,
};

const msToSamples = (ms) => Math.round((ms / 1000) * CONTINUOUS_SAMPLE_RATE);

function frameRms(frame) {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

function concat(chunks, total) {
  const samples = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}

export class ContinuousSegmenter {
  constructor({ onSegment, onSubmit, ...options } = {}) {
    const config = { ...CONTINUOUS_SEGMENTER_DEFAULTS, ...options };
    this._onSegment = onSegment ?? (() => {});
    this._onSubmit = onSubmit ?? (() => {});
    this._phrasePause = msToSamples(config.phrasePauseMs);
    // Enter can only follow a finished phrase.
    this._submitSilence = Math.max(
      msToSamples(config.submitSilenceMs),
      this._phrasePause + msToSamples(100)
    );
    this._preRoll = msToSamples(config.preRollMs);
    this._trailingKeep = msToSamples(config.trailingKeepMs);
    this._minSpeech = msToSamples(config.minSpeechMs);
    this._chunkTarget = msToSamples(config.chunkTargetMs);
    this._chunkMax = msToSamples(config.chunkMaxMs);
    this._quietSearch = msToSamples(1500);
    this._speechStartFrames = config.speechStartFrames;
    this._minSpeechRms = config.minSpeechRms;
    this._minSilenceRms = config.minSilenceRms;

    this._noiseFloor = null;
    this._level = 0;
    this._preRollChunks = [];
    this._preRollLevels = [];
    this._preRollSamples = 0;
    this._startCandidates = 0;
    this._inSpeech = false;
    this._segmentChunks = [];
    this._segmentLevels = [];
    this._speechLevelSum = 0;
    this._speechFrames = 0;
    this._afterWordGap = false;
    this._segmentSamples = 0;
    this._speechSamples = 0;
    this._trailingSilence = 0;
    this._silenceSinceSpeech = 0;
    this._silenceBeforeSegment = 0;
    this._segmentPreRoll = 0;
    this._pendingPhrases = 0;
    this._unsubmitted = false;
  }

  // A phrase passed to onSegment has been transcribed and pasted (or dropped):
  // the submit countdown starts again from now.
  phraseSettled() {
    this._pendingPhrases = Math.max(0, this._pendingPhrases - 1);
    this._silenceSinceSpeech = 0;
    this._silenceBeforeSegment = 0;
  }

  // Live input level (RMS) of the newest frame, for the pill's waveform.
  getLevel() {
    return this._level;
  }

  // Each worklet message is one frame (800 samples = 50 ms).
  push(frame) {
    if (!frame?.length) return;
    const rms = frameRms(frame);
    this._level = rms;
    const isSpeech = this._classify(rms);
    this._trackNoiseFloor(rms, isSpeech);

    if (!this._inSpeech) {
      this._remember(frame, rms);
      if (isSpeech) {
        this._startCandidates += 1;
        if (this._startCandidates >= this._speechStartFrames) this._openSegment();
      } else {
        this._startCandidates = 0;
        this._silenceSinceSpeech += frame.length;
        this._maybeSubmit();
      }
      return;
    }

    this._segmentChunks.push(frame);
    this._segmentLevels.push(rms);
    this._segmentSamples += frame.length;
    if (isSpeech) {
      this._speechSamples += frame.length;
      this._speechLevelSum += rms;
      this._speechFrames += 1;
      this._trailingSilence = 0;
      this._silenceSinceSpeech = 0;
    } else {
      this._trailingSilence += frame.length;
      this._silenceSinceSpeech += frame.length;
    }

    if (this._trailingSilence >= this._phrasePause) {
      this._closeSegment();
      this._maybeSubmit();
    } else if (
      this._afterWordGap &&
      !this._isWordGap(rms, isSpeech) &&
      this._segmentSamples >= this._chunkTarget &&
      this._speechSamples >= this._minSpeech
    ) {
      // Speech resumed after a dip: cut in the gap, before this frame. A dip
      // that turns into a pause ends the phrase at the pause instead.
      this._cutMidSpeech(this._segmentChunks.length - 1);
    } else if (this._segmentSamples >= this._chunkMax) {
      this._cutMidSpeech(this._quietestFrameIndex() + 1);
    }
    this._afterWordGap = this._inSpeech && this._isWordGap(rms, isSpeech);
  }

  // A frame well below the phrase's own speaking level is a gap between words,
  // where a cut won't split one.
  _isWordGap(rms, isSpeech) {
    if (!isSpeech) return true;
    const speechLevel = this._speechFrames > 0 ? this._speechLevelSum / this._speechFrames : 0;
    return rms < speechLevel * 0.35;
  }

  _quietestFrameIndex() {
    let index = this._segmentChunks.length - 1;
    let samples = 0;
    let quietest = index;
    for (; index >= 0 && samples < this._quietSearch; index--) {
      samples += this._segmentChunks[index].length;
      if (this._segmentLevels[index] < this._segmentLevels[quietest]) quietest = index;
    }
    return quietest;
  }

  // Emits the phrase so far while the user is still talking; the frames after
  // the cut start the next phrase, so nothing spoken is lost.
  _cutMidSpeech(endIndex) {
    const chunks = this._segmentChunks.slice(0, endIndex);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const leftover = this._segmentChunks.slice(endIndex);
    const leftoverLevels = this._segmentLevels.slice(endIndex);
    this._emit(chunks, total, this._speechSamples, { endedAtPause: false, trailing: 0 });
    this._segmentChunks = leftover;
    this._segmentLevels = leftoverLevels;
    this._segmentSamples = leftover.reduce((sum, chunk) => sum + chunk.length, 0);
    // Still mid-speech: the leftover counts as speech for the next phrase's minimum.
    this._speechSamples = this._segmentSamples;
    this._trailingSilence = 0;
  }

  // End of the session: a phrase still being spoken is emitted; Enter is not
  // pressed, since the user stopped rather than paused.
  flush() {
    if (this._inSpeech) this._closeSegment();
  }

  _classify(rms) {
    const floor = this._noiseFloor ?? rms;
    if (this._inSpeech) {
      // Hysteresis: speech holds until the level falls back near the floor.
      return rms >= Math.max(this._minSilenceRms, floor * 2);
    }
    return rms >= Math.max(this._minSpeechRms, floor * 3);
  }

  // Follows the room's level down quickly and up slowly, and never learns
  // from speech, so a fan or hum raises the bar but a voice does not.
  _trackNoiseFloor(rms, isSpeech) {
    if (this._noiseFloor === null) {
      // Capped so a session that opens mid-word doesn't take the voice as the room.
      this._noiseFloor = Math.min(rms, this._minSilenceRms);
    } else if (rms < this._noiseFloor) {
      this._noiseFloor = this._noiseFloor * 0.7 + rms * 0.3;
    } else if (!isSpeech) {
      this._noiseFloor = this._noiseFloor * 0.98 + rms * 0.02;
    }
  }

  _remember(frame, rms) {
    this._preRollChunks.push(frame);
    this._preRollLevels.push(rms);
    this._preRollSamples += frame.length;
    while (
      this._preRollChunks.length > 1 &&
      this._preRollSamples - this._preRollChunks[0].length >= this._preRoll
    ) {
      this._preRollSamples -= this._preRollChunks.shift().length;
      this._preRollLevels.shift();
    }
  }

  _openSegment() {
    this._inSpeech = true;
    // Kept in case this turns out to be a noise burst too short for a phrase,
    // which must not restart the submit countdown.
    this._silenceBeforeSegment = this._silenceSinceSpeech;
    this._segmentPreRoll = this._preRollSamples;
    this._segmentChunks = this._preRollChunks;
    this._segmentLevels = this._preRollLevels;
    this._segmentSamples = this._preRollSamples;
    this._speechLevelSum = 0;
    this._speechFrames = 0;
    this._afterWordGap = false;
    // The confirming frames are speech; count them so a short word still clears minSpeech.
    const lastFrame = this._preRollChunks[this._preRollChunks.length - 1];
    this._speechSamples = (lastFrame?.length ?? 0) * this._startCandidates;
    this._preRollChunks = [];
    this._preRollLevels = [];
    this._preRollSamples = 0;
    this._startCandidates = 0;
    this._trailingSilence = 0;
    this._silenceSinceSpeech = 0;
  }

  _closeSegment() {
    const chunks = this._segmentChunks;
    const total = this._segmentSamples;
    const speech = this._speechSamples;
    const trailing = this._trailingSilence;
    this._inSpeech = false;
    this._segmentChunks = [];
    this._segmentLevels = [];
    this._segmentSamples = 0;
    this._speechSamples = 0;
    this._trailingSilence = 0;
    if (speech < this._minSpeech) {
      // A click, breath or cough: the countdown carries on as if it were silence.
      this._silenceSinceSpeech = this._silenceBeforeSegment + total - this._segmentPreRoll;
      return;
    }
    this._emit(chunks, total, speech, { endedAtPause: true, trailing });
  }

  _emit(chunks, total, speech, { endedAtPause, trailing }) {
    this._unsubmitted = true;
    this._pendingPhrases += 1;
    const kept = total - Math.max(0, trailing - this._trailingKeep);
    this._onSegment(concat(chunks, total).subarray(0, kept), {
      durationMs: Math.round((kept / CONTINUOUS_SAMPLE_RATE) * 1000),
      speechMs: Math.round((speech / CONTINUOUS_SAMPLE_RATE) * 1000),
      // False when cut while the user kept talking: the sentence goes on in the next phrase.
      endedAtPause,
    });
  }

  _maybeSubmit() {
    if (!this._unsubmitted || this._inSpeech || this._pendingPhrases > 0) return;
    if (this._silenceSinceSpeech < this._submitSilence) return;
    this._unsubmitted = false;
    this._onSubmit();
  }
}

import { buildWav, WAV_HEADER_BYTES } from "../utils/wavBuilder";

// Decodes an offline Parakeet recording's finished stretches while the user is
// still speaking, so after stop only the tail is left to transcribe. Recordings
// the batch path would keep whole are never cut, and longer ones are cut where
// the batch splitter looks for its cuts, so the text has as many seams (each
// stretch is capitalised and punctuated on its own) as the batch path's.

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 160; // 10 ms
const FRAMES_PER_SECOND = SAMPLE_RATE / FRAME_SAMPLES;
// The batch path decodes a recording up to its segment cap plus tail allowance
// in one piece (parakeetSegmentation); cutting earlier would change the text.
const FIRST_CUT_SECONDS = 15.5;
// The batch path's segment cap (parakeetServer MAX_SEGMENT_SECONDS); past it
// the cut is forced at the quietest moment, as the batch path does.
const MAX_SECONDS = 15;
// The batch splitter looks for its cut in the last 4 s before the cap
// (parakeetSegmentation SEARCH_SECONDS). An earlier cut would add seams.
const MIN_SECONDS = MAX_SECONDS - 4;
// Twice the batch splitter's window: a pause this long is rarely inside a word
// or a sentence, so live cuts seldom split a clause the cleanup must rejoin.
const PAUSE_FRAMES = 20;
// A pause is a window 15 dB below the stretch's average frame. Soft syllables
// sit within about 12 dB of it; at 20 dB most real pauses no longer qualify
// and cuts fall back to the quietest moment.
const PAUSE_ENERGY_RATIO = 0.03;
// The newest audio may be the start of a word that is still arriving.
const GUARD_FRAMES = 0.3 * FRAMES_PER_SECOND;
// A tail shorter than this holds no word; skipping it saves a round trip.
const MIN_TAIL_SECONDS = 0.1;
// Decoded alone, a tail this short invents filler from room tone or drops a
// lone word. One with speech is decoded together with the stretch before it,
// and one without is skipped. A longer tail is always decoded: it may be a
// last sentence spoken much more quietly than the rest.
const SHORT_TAIL_SECONDS = 2;
// parakeetServer's SILENCE_RMS_THRESHOLD: quieter audio is never decoded, so
// an empty result below it means silence, and above it a failed decode.
const SILENCE_RMS = 0.001;
// How much new audio arrives between looks for a cut.
const CHECK_SAMPLES = SAMPLE_RATE / 2;

function frameEnergies(samples) {
  const energies = new Float64Array(Math.floor(samples.length / FRAME_SAMPLES));
  for (let f = 0; f < energies.length; f++) {
    let sum = 0;
    for (let i = f * FRAME_SAMPLES; i < (f + 1) * FRAME_SAMPLES; i++) {
      const value = samples[i] / 32768;
      sum += value * value;
    }
    energies[f] = sum;
  }
  return energies;
}

const averageOf = (energies) =>
  energies.reduce((sum, energy) => sum + energy, 0) / Math.max(1, energies.length);

// The window of PAUSE_FRAMES starting in [from, to] with the least energy.
function quietestWindow(energies, from, to) {
  let best = null;
  let sum = 0;
  for (let i = from; i < from + PAUSE_FRAMES; i++) sum += energies[i];
  for (let start = from; start <= to; start++) {
    if (best === null || sum < best.energy) best = { start, energy: sum };
    sum += (energies[start + PAUSE_FRAMES] ?? 0) - energies[start];
  }
  return best;
}

// The average frame energy of the loudest PAUSE_FRAMES window.
function loudestWindowEnergy(energies) {
  let best = 0;
  let sum = 0;
  for (let i = 0; i < energies.length; i++) {
    sum += energies[i] - (energies[i - PAUSE_FRAMES] ?? 0);
    best = Math.max(best, sum);
  }
  return best / PAUSE_FRAMES;
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i] / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

// Where to end the next finished stretch of `samples` (int16 PCM since the
// last cut), as a sample offset, or null while it should keep growing.
export function findLiveCut(samples) {
  const energies = frameEnergies(samples);
  const frames = energies.length;
  const minFrames = MIN_SECONDS * FRAMES_PER_SECOND;
  const maxFrames = MAX_SECONDS * FRAMES_PER_SECOND;
  const searchEnd = Math.min(frames - GUARD_FRAMES, maxFrames) - PAUSE_FRAMES;
  if (searchEnd < minFrames) return null;

  // An all-silent stretch (a muted mic) has nothing to decode.
  const average = averageOf(energies);
  if (average === 0) return null;
  const quietest = quietestWindow(energies, minFrames, searchEnd);
  const isPause = quietest.energy / PAUSE_FRAMES < average * PAUSE_ENERGY_RATIO;
  // Without a pause the stretch grows to the cap, plus the guard that keeps
  // the forced cut clear of the newest audio.
  if (!isPause && frames < maxFrames + GUARD_FRAMES) return null;
  return (quietest.start + PAUSE_FRAMES / 2) * FRAME_SAMPLES;
}

export class LiveParakeetDecoder {
  // `tap` is the recording's PcmTap; `transcribe` takes a 16 kHz PCM16 WAV
  // ArrayBuffer and resolves like electronAPI.transcribeLocalParakeet; `route`
  // is the { model, language } it decodes with.
  // Driven by the tap's own audio, so nothing outlives the recording.
  constructor(tap, transcribe, route) {
    this._tap = tap;
    this._transcribe = transcribe;
    this._route = route;
    this._cut = 0;
    this._checkedAt = 0;
    this._parts = [];
    this._inFlight = null;
    this._failed = false;
    this._finished = null;
    this._onSamples = (count) => {
      if (count - this._checkedAt < CHECK_SAMPLES) return;
      this._checkedAt = count;
      this._poll();
    };
    tap.onSamples = this._onSamples;
  }

  _poll() {
    const end = this._tap.sampleCount;
    // One stretch in flight at a time, so a cancelled recording leaves at most
    // one decode running.
    if (this._failed || this._inFlight || end < FIRST_CUT_SECONDS * SAMPLE_RATE) return;
    if (end - this._cut < MIN_SECONDS * SAMPLE_RATE) return;
    const pending = this._tap.copySamples(this._cut, end);
    const cut = findLiveCut(pending);
    if (cut === null) return;
    const text = this._decode(pending.subarray(0, cut));
    this._inFlight = text;
    text.then(
      () => {
        this._inFlight = null;
      },
      // Marks the run failed early; finish() still sees the rejection.
      () => {
        this._failed = true;
      }
    );
    this._parts.push({ start: this._cut, text });
    this._cut += cut;
  }

  // `quiet` audio is no louder than the recording's pauses, so an empty
  // result for it is silence too.
  async _decode(samples, quiet = false) {
    const wav = await buildWav(samples, SAMPLE_RATE).arrayBuffer();
    const result = await this._transcribe(wav);
    // A partial decode is left to the batch path, which reports it to the user.
    if (result?.success && !result.warning) return result.text;
    const silent = quiet || rms(samples) < SILENCE_RMS;
    if (result?.code === "NO_SPEECH_DETECTED" && silent) return "";
    throw new Error(result?.message || "Live Parakeet segment failed");
  }

  // Stops taking stretches; call before the tap stops.
  stop() {
    if (this._tap.onSamples === this._onSamples) this._tap.onSamples = null;
  }

  // The recording's text from the decoded stretches plus its tail, or null
  // when the caller should decode the whole recording instead: nothing was
  // decoded live, the full capture is missing, a stretch failed, or the
  // recording now goes to another model or language than `route`.
  finish(rawWav, route) {
    this.stop();
    if (route?.model !== this._route?.model || route?.language !== this._route?.language) {
      return Promise.resolve(null);
    }
    this._finished ??= this._finish(rawWav);
    return this._finished;
  }

  async _finish(rawWav) {
    if (!this._parts.length || !rawWav || this._failed) return null;
    try {
      const samples = new Int16Array(await rawWav.arrayBuffer(), WAV_HEADER_BYTES);
      if (samples.length < this._cut) return null;
      const parts = this._parts.map((part) => part.text);
      const tail = samples.subarray(this._cut);
      if (tail.length >= MIN_TAIL_SECONDS * SAMPLE_RATE) {
        const spoken = this._hasSpeech(samples, tail);
        if (tail.length >= SHORT_TAIL_SECONDS * SAMPLE_RATE) {
          parts.push(this._decode(tail, !spoken));
        } else if (spoken) {
          const last = this._parts[this._parts.length - 1];
          parts[parts.length - 1] = this._decode(samples.subarray(last.start));
        }
      }
      const text = (await Promise.all(parts)).filter(Boolean).join(" ");
      return text || null;
    } catch {
      return null;
    }
  }

  // Whether the tail holds anything louder than the recording's pauses.
  _hasSpeech(samples, tail) {
    const average = averageOf(frameEnergies(samples));
    return loudestWindowEnergy(frameEnergies(tail)) > average * PAUSE_ENERGY_RATIO;
  }

  get segmentCount() {
    return this._parts.length;
  }
}

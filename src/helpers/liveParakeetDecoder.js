import { buildWav } from "../utils/wavBuilder";

// Decodes an offline Parakeet recording's finished stretches while the user is
// still speaking, so after stop only the tail is left to transcribe. Each
// stretch ends at a clear pause, which is where the batch path already splits
// long audio (parakeetSegmentation), so the pieces decode the same way.

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 160; // 10 ms
const FRAMES_PER_SECOND = SAMPLE_RATE / FRAME_SAMPLES;
// A stretch shorter than this is left to grow: a lone short clause decodes
// with too little context.
const MIN_SECONDS = 6;
// The batch path's segment cap (parakeetServer MAX_SEGMENT_SECONDS); past it
// the cut is forced at the quietest moment, as the batch path does.
const MAX_SECONDS = 15;
const FORCED_SEARCH_SECONDS = 4;
// Twice the batch splitter's window: a pause this long is rarely inside a word
// or a sentence, so live cuts seldom split a clause the cleanup must rejoin.
const PAUSE_FRAMES = 20;
// A pause is a window this much quieter than the stretch's average frame.
const PAUSE_ENERGY_RATIO = 0.1;
// The newest audio may be the start of a word that is still arriving.
const GUARD_SECONDS = 0.3;
// A tail shorter than this holds no word; skipping it saves a round trip.
const MIN_TAIL_SECONDS = 0.1;
// How much new audio arrives between looks for a cut.
const CHECK_SAMPLES = SAMPLE_RATE / 2;
const WAV_HEADER_BYTES = 44;

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

// Where to end the next finished stretch of `samples` (int16 PCM since the
// last cut), as a sample offset, or null while it should keep growing.
export function findLiveCut(samples) {
  const energies = frameEnergies(samples);
  const frames = energies.length;
  const minFrames = MIN_SECONDS * FRAMES_PER_SECOND;
  const maxFrames = MAX_SECONDS * FRAMES_PER_SECOND;
  if (frames < minFrames) return null;

  const average = energies.reduce((sum, energy) => sum + energy, 0) / frames;
  const searchEnd = Math.min(frames - GUARD_SECONDS * FRAMES_PER_SECOND, maxFrames) - PAUSE_FRAMES;
  if (searchEnd >= minFrames) {
    const pause = quietestWindow(energies, minFrames, searchEnd);
    if (pause.energy / PAUSE_FRAMES <= average * PAUSE_ENERGY_RATIO) {
      return (pause.start + PAUSE_FRAMES / 2) * FRAME_SAMPLES;
    }
  }
  if (frames < maxFrames) return null;
  const forced = quietestWindow(
    energies,
    maxFrames - FORCED_SEARCH_SECONDS * FRAMES_PER_SECOND,
    maxFrames - PAUSE_FRAMES
  );
  return (forced.start + PAUSE_FRAMES / 2) * FRAME_SAMPLES;
}

export class LiveParakeetDecoder {
  // `tap` is the recording's PcmTap; `transcribe` takes a 16 kHz PCM16 WAV
  // ArrayBuffer and resolves like electronAPI.transcribeLocalParakeet.
  // Driven by the tap's own audio, so nothing outlives the recording.
  constructor(tap, transcribe) {
    this._tap = tap;
    this._transcribe = transcribe;
    this._cut = 0;
    this._checkedAt = 0;
    this._parts = [];
    this._failed = false;
    this._onSamples = (count) => {
      if (count - this._checkedAt < CHECK_SAMPLES) return;
      this._checkedAt = count;
      this._poll();
    };
    tap.onSamples = this._onSamples;
  }

  _poll() {
    const end = this._tap.sampleCount;
    if (this._failed || end - this._cut < MIN_SECONDS * SAMPLE_RATE) return;
    const pending = this._tap.copySamples(this._cut, end);
    const cut = findLiveCut(pending);
    if (cut === null) return;
    const part = this._decode(pending.subarray(0, cut));
    // Marks the run failed early; finish() still sees the rejection.
    part.catch(() => {
      this._failed = true;
    });
    this._parts.push(part);
    this._cut += cut;
  }

  async _decode(samples) {
    const wav = await buildWav(samples, SAMPLE_RATE).arrayBuffer();
    const result = await this._transcribe(wav);
    if (result?.success) return result.text;
    if (result?.code === "NO_SPEECH_DETECTED") return "";
    throw new Error(result?.message || "Live Parakeet segment failed");
  }

  // Stops taking stretches; call before the tap stops.
  stop() {
    if (this._tap.onSamples === this._onSamples) this._tap.onSamples = null;
  }

  // The recording's text from the decoded stretches plus its tail, or null
  // when the caller should decode the whole recording instead: nothing was
  // decoded live, the full capture is missing, or a stretch failed.
  async finish(rawWav) {
    this.stop();
    if (!this._parts.length || !rawWav || this._failed) return null;
    try {
      const samples = new Int16Array(await rawWav.arrayBuffer(), WAV_HEADER_BYTES);
      if (samples.length < this._cut) return null;
      const tail = samples.subarray(this._cut);
      const tailPart =
        tail.length >= MIN_TAIL_SECONDS * SAMPLE_RATE ? this._decode(tail) : Promise.resolve("");
      const text = (await Promise.all([...this._parts, tailPart])).filter(Boolean).join(" ");
      return text || null;
    } catch {
      return null;
    }
  }

  get segmentCount() {
    return this._parts.length;
  }
}

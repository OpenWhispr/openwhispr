import { buildWav } from "../utils/wavBuilder";

const SAMPLE_RATE = 16000;
// Longer recordings fall back to the WebM path: the WAV crosses IPC in one
// message and must stay well inside Electron's comfortable payload size.
const MAX_SECONDS = 240;
const FLUSH_WATCHDOG_MS = 1000;
// A copy shorter than its recording by more than this lost frames to a render
// loop that came up late or stalled; the WebM has them, so it wins.
const COVERAGE_TOLERANCE_MS = 100;

// A 16 kHz mono PCM16 shadow of the batch MediaRecorder, so an offline local
// engine decodes it as-is instead of waiting for FFmpeg to unpack WebM/Opus
// after stop. Reuses the preview worklet processor. Build it before the mic
// opens so the graph is already rendering when attach() runs beside
// recorder.start(); stop() yields null for anything the copy cannot vouch for.
export class PcmTap {
  constructor(
    workletUrl,
    { maxSamples = SAMPLE_RATE * MAX_SECONDS, now = () => performance.now() } = {}
  ) {
    this._chunks = [];
    this._samples = 0;
    this._maxSamples = maxSamples;
    this._now = now;
    this._attachedAt = null;
    this._dropped = false;
    this._node = null;
    this._source = null;
    this._flushResolve = null;
    this._context = new AudioContext({ sampleRate: SAMPLE_RATE });
    // Not awaited: resume() can hang when the output device is wedged.
    if (this._context.state === "suspended") this._context.resume().catch(() => {});
    this._ready = this._context.audioWorklet
      .addModule(workletUrl)
      .then(() => {
        // Mono like FFmpeg's -ac 1, so a stereo device with one live channel
        // decodes the same either way.
        this._node = new AudioWorkletNode(this._context, "pcm-streaming-processor", {
          channelCount: 1,
          channelCountMode: "explicit",
        });
        this._node.port.onmessage = (event) => this._onMessage(event.data);
        this._source?.connect(this._node);
      })
      .catch(() => {
        this._dropped = true;
      });
  }

  _onMessage(data) {
    if (data === "flushed") {
      this._flushResolve?.();
      return;
    }
    if (this._dropped) return;
    const chunk = new Int16Array(data);
    this._samples += chunk.length;
    if (this._samples > this._maxSamples) {
      this._dropped = true;
      this._chunks = [];
      return;
    }
    this._chunks.push(chunk);
  }

  // Feeds the recorder's stream, or moves the tap onto a replacement mic.
  attach(stream) {
    this._source?.disconnect();
    this._source = this._context.createMediaStreamSource(stream);
    if (this._node) this._source.connect(this._node);
    this._attachedAt ??= this._now();
  }

  // Resolves to the capture as a WAV blob, or null when the copy cannot stand
  // in for the WebM: the worklet failed to load, the recording ran too long,
  // the flush never arrived, or the copy is shorter than the recording.
  async stop() {
    let watchdog;
    const flushed = await Promise.race([
      this._ready.then(() => {
        if (!this._node || this._dropped) return false;
        return new Promise((resolve) => {
          this._flushResolve = () => resolve(true);
          this._node.port.postMessage("stop");
        });
      }),
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve(false), FLUSH_WATCHDOG_MS);
      }),
    ]);
    clearTimeout(watchdog);
    const { _chunks: chunks, _samples: total, _dropped: dropped, _attachedAt: attachedAt } = this;
    const covered =
      attachedAt !== null &&
      total >= ((this._now() - attachedAt - COVERAGE_TOLERANCE_MS) / 1000) * SAMPLE_RATE;
    this.close();
    if (!flushed || dropped || !covered || total === 0) return null;
    const samples = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return buildWav(samples, SAMPLE_RATE);
  }

  close() {
    this._chunks = [];
    this._samples = 0;
    this._node?.disconnect();
    this._source?.disconnect();
    this._context.close().catch(() => {});
  }
}

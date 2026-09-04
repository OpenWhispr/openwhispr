// Chromium's MediaRecorder only offers WebM/Opus (and MP4/AAC) on the desktop
// platforms we ship, so every dictation reaches the upload path as WebM. Most
// OpenAI-compatible transcription backends accept that, but some decode the
// bytes themselves and reject anything outside WAV/MP3/FLAC — Azure's
// MAI-Transcribe, reached through OpenRouter, is one. Those endpoints are only
// selectable via the Custom provider, so the conversion is scoped there and
// every built-in provider keeps sending Opus untouched.
//
// The rejection is by content, not by labelling: renaming the part or rewriting
// its Content-Type does not help, so the audio has to actually be re-encoded.

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

// Speech models resample to 16 kHz mono internally, and the main process
// already standardises on it (ffmpegUtils.convertToWav defaults to exactly
// this), so matching it here keeps the two conversion paths consistent and
// keeps the upload ~6x smaller than the decoded 48 kHz stream.
const TARGET_SAMPLE_RATE = 16000;

// Containers these backends already accept. Anything else is re-encoded --
// an allowlist rather than a list of known-bad containers, so a format we
// have not seen yet (MP4/AAC on some platforms) converts instead of being
// uploaded and rejected.
const ACCEPTED_CONTAINERS = ["wav", "x-wav", "wave", "mpeg", "mp3", "flac"];

export function needsWavConversion(
  provider: string | undefined,
  mimeType: string | undefined,
  size?: number
): boolean {
  if (provider !== "custom") return false;
  // An empty recording has nothing to decode; converting it would only turn a
  // silent no-op into a spurious "re-encode failed" warning.
  if (size === 0) return false;
  const type = (mimeType || "").toLowerCase();
  if (!type) return false;
  return !ACCEPTED_CONTAINERS.some((container) => type.includes(container));
}

// Interleaved 16-bit PCM in a RIFF container. Kept pure and free of Web Audio
// types so it can be unit-tested without a browser.
export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  if (!channels.length) throw new Error("encodeWav requires at least one channel");

  const channelCount = channels.length;
  const frameCount = channels[0].length;
  const dataBytes = frameCount * channelCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * BYTES_PER_SAMPLE, true);
  view.setUint16(32, channelCount * BYTES_PER_SAMPLE, true);
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      // Clamp before scaling: decoded float samples can sit slightly outside
      // [-1, 1] and would otherwise wrap to the opposite rail.
      const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)), true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return buffer;
}

// Averages channels into one. Speech backends gain nothing from stereo and it
// doubles the upload, so the mono mixdown happens before encoding.
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (!channels.length) throw new Error("downmixToMono requires at least one channel");
  if (channels.length === 1) return channels[0];

  const frameCount = channels[0].length;
  const mono = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels.length; channel++) sum += channels[channel][frame];
    mono[frame] = sum / channels.length;
  }
  return mono;
}

// Renderer-side conversion, using Web Audio because ffmpeg is only reachable
// from the main process. Retries re-upload stored audio from there and cannot
// use this, so they go through ffmpegUtils.convertBufferToWav instead -- both
// paths target 16 kHz mono so the upload is identical either way.
export async function convertToWav(blob: Blob): Promise<Blob> {
  const OfflineCtor =
    (globalThis as any).OfflineAudioContext || (globalThis as any).webkitOfflineAudioContext;
  if (!OfflineCtor) throw new Error("Web Audio is unavailable in this context");

  // Decoding through an OfflineAudioContext resamples to the context rate, so
  // the 48 kHz recording arrives already downsampled -- and unlike a live
  // AudioContext it neither opens an output device nor inherits whatever rate
  // the hardware happens to run at.
  const context = new OfflineCtor(1, 1, TARGET_SAMPLE_RATE);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());

  // decodeAudioData honours the context's sample rate but not its channel
  // count, so a stereo input still decodes to two channels and has to be
  // downmixed explicitly.
  const channels: Float32Array[] = [];
  for (let i = 0; i < decoded.numberOfChannels; i++) channels.push(decoded.getChannelData(i));

  return new Blob([encodeWav([downmixToMono(channels)], decoded.sampleRate)], {
    type: "audio/wav",
  });
}

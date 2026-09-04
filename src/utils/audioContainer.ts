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

// Containers Chromium can produce that a WAV/MP3/FLAC-only backend will refuse.
const REENCODE_CONTAINERS = ["webm", "ogg", "matroska"];

export function needsWavConversion(
  provider: string | undefined,
  mimeType: string | undefined
): boolean {
  if (provider !== "custom") return false;
  const type = (mimeType || "").toLowerCase();
  return REENCODE_CONTAINERS.some((container) => type.includes(container));
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

// Renderer-only: decodes through Web Audio rather than ffmpeg, which lives in
// the main process and would need IPC plumbing for what is otherwise a
// self-contained step on the upload path.
export async function convertToWav(blob: Blob): Promise<Blob> {
  const AudioContextCtor =
    (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("Web Audio is unavailable in this context");

  const context = new AudioContextCtor();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let i = 0; i < decoded.numberOfChannels; i++) channels.push(decoded.getChannelData(i));
    return new Blob([encodeWav(channels, decoded.sampleRate)], { type: "audio/wav" });
  } finally {
    // Best-effort: an already-closed or non-closable context must not mask a
    // decode error on the way out.
    try {
      await context.close?.();
    } catch {
      /* ignore */
    }
  }
}

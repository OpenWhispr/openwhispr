export interface MicStream {
  stop: () => Promise<void>;
}

interface MicStreamOptions {
  deviceId?: string | null;
  /** Receives 512-sample mono frames at 16 kHz (Silero's window size). */
  onFrame: (frame: Float32Array) => void;
}

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512;

const WORKLET_SOURCE = `
class VoiceSpikeFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(${FRAME_SIZE});
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, ${FRAME_SIZE} - this.filled);
      this.frame.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === ${FRAME_SIZE}) {
        const out = this.frame;
        this.port.postMessage(out, [out.buffer]);
        this.frame = new Float32Array(${FRAME_SIZE});
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("voice-spike-frames", VoiceSpikeFrameProcessor);
`;

/**
 * Opens the mic with Chromium's echo cancellation ON — unlike dictation, which
 * disables it — so the assistant's own playback is removed before the VAD hears it.
 */
async function openEchoCancelledMic(deviceId?: string | null): Promise<MediaStream> {
  const constraints = (id?: string | null): MediaStreamConstraints => ({
    audio: {
      ...(id ? { deviceId: { exact: id } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(deviceId));
  } catch (error) {
    // A saved device id that no longer matches any device throws an
    // OverconstrainedError (empty message); fall back to the default mic.
    const name = (error as DOMException)?.name;
    if (deviceId && (name === "OverconstrainedError" || name === "NotFoundError")) {
      return navigator.mediaDevices.getUserMedia(constraints(null));
    }
    throw error;
  }
}

export async function startMicStream({ deviceId, onFrame }: MicStreamOptions): Promise<MicStream> {
  const stream = await openEchoCancelledMic(deviceId);
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  // Started from a global hotkey, not a click, so Chromium may create it suspended
  // and the worklet would never run.
  if (context.state === "suspended") await context.resume();
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "voice-spike-frames");
  node.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data);
  source.connect(node);

  return {
    async stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      for (const track of stream.getTracks()) track.stop();
      await context.close();
    },
  };
}

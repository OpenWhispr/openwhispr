import logger from "./logger";

// Module-level reference prevents the hidden video element from being garbage
// collected while the capture session is active. getDisplayMedia requires
// active video frame consumption to keep the loopback audio pump alive.
let activeVideoSink: HTMLVideoElement | null = null;

/**
 * Capture system audio via getDisplayMedia (CoreAudio Taps on macOS / Electron 39+).
 * Returns a MediaStream with audio (and video tracks that must stay alive).
 * Returns null if capture fails or no audio tracks are available.
 */
export async function getSystemAudioStream(): Promise<MediaStream | null> {
  try {
    // Use getDisplayMedia (handled by setDisplayMediaRequestHandler in main process)
    // which properly captures system audio via macOS CoreAudio Taps.
    // Disable all audio processing — echo cancellation and noise suppression
    // on loopback audio can cancel out the captured system audio entirely,
    // especially when Bluetooth headphones change the audio routing.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: true,
    });

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();

    // Belt-and-suspenders: also apply constraints directly on the track
    // in case getDisplayMedia ignored the initial constraints.
    if (audioTracks[0]) {
      try {
        await audioTracks[0].applyConstraints({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        });
      } catch {}
    }

    logger.debug(
      "Display media stream obtained",
      {
        audioTracks: audioTracks.length,
        videoTracks: videoTracks.length,
        audioSettings: audioTracks[0]?.getSettings(),
      },
      "audio"
    );

    if (!audioTracks.length) {
      logger.error("No audio track in display media stream", {}, "audio");
      videoTracks.forEach((t) => t.stop());
      return null;
    }

    // getDisplayMedia requires active video frame consumption to pump the capture
    // session. Without a consumer, the loopback audio track may produce silence.
    // Attach the stream to a hidden <video> element so Chromium pulls frames and
    // keeps the session active.
    // IMPORTANT: Store in module-level variable to prevent garbage collection.
    activeVideoSink = document.createElement("video");
    activeVideoSink.srcObject = new MediaStream(videoTracks);
    activeVideoSink.muted = true;
    activeVideoSink.play().catch(() => {});

    audioTracks[0].addEventListener("ended", () => {
      logger.error("System audio track ended unexpectedly", {}, "audio");
      if (activeVideoSink) {
        activeVideoSink.srcObject = null;
        activeVideoSink = null;
      }
    });

    return stream;
  } catch (err) {
    logger.error("Failed to capture system audio", { error: (err as Error).message }, "audio");
    return null;
  }
}

/**
 * Stop all tracks (audio + video) on a system audio stream.
 */
export function stopSystemAudioStream(stream: MediaStream | null): void {
  if (!stream) return;
  try {
    stream.getTracks().forEach((t) => t.stop());
  } catch {}
  if (activeVideoSink) {
    activeVideoSink.srcObject = null;
    activeVideoSink = null;
  }
}

import logger from "./logger";

/**
 * Capture system audio via getDisplayMedia (ScreenCaptureKit loopback on macOS).
 * Returns a MediaStream with audio (and video tracks that must stay alive on macOS).
 * Returns null if capture fails or no audio tracks are available.
 */
export async function getSystemAudioStream(): Promise<MediaStream | null> {
  try {
    // Use getDisplayMedia (handled by setDisplayMediaRequestHandler in main process)
    // which properly captures system audio via macOS ScreenCaptureKit loopback.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
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

    // Video tracks must stay alive — stopping them kills the ScreenCaptureKit loopback audio

    audioTracks[0].addEventListener("ended", () => {
      logger.error("System audio track ended unexpectedly", {}, "audio");
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
}

const TRACK_READY_TIMEOUT_MS = 600;

// Waits until a capture track is actually delivering audio (wake-after-idle re-acquire).
// After the OS suspends the input during idle, getUserMedia can hand back a track that
// stays muted/ended and yields silence; callers use this to detect that and re-acquire.
export const waitForTrackReady = (track, timeoutMs) =>
  new Promise((resolve) => {
    // Dead track will never deliver audio — fail fast so the caller re-acquires.
    if (!track || track.readyState === "ended") {
      resolve(false);
      return;
    }

    // Common warm-device case: already unmuted, resolve with zero latency.
    if (!track.muted) {
      resolve(true);
      return;
    }

    let settled = false;
    let timer = null;

    // Clear timer and detach both listeners on every exit path (no leaks).
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      track.removeEventListener("unmute", onUnmute);
      track.removeEventListener("ended", onEnded);
    };

    const settle = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    function onUnmute() {
      settle(true);
    }

    function onEnded() {
      settle(false);
    }

    track.addEventListener("unmute", onUnmute);
    track.addEventListener("ended", onEnded);

    // Fallback: if neither event fires, treat a still-live unmuted track as ready.
    timer = setTimeout(() => {
      settle(!track.muted && track.readyState !== "ended");
    }, timeoutMs);
  });

// Re-acquires the mic once if the first track never delivers audio (dead/muted after idle).
// getFreshConstraints must drop any pinned device id so the retry re-resolves the device.
// Returns a live stream — the original when it was healthy or the retry failed.
// Optional fallback = { getConstraints, onDeviceRejected, onFallbackUnusable } adds a second
// hop to the system default when the retry reopens the same device and it is still silent.
export const reacquireIfDead = async (stream, getFreshConstraints, logger, fallback = null) => {
  const track = stream.getAudioTracks()[0];
  if (!track || (await waitForTrackReady(track, TRACK_READY_TIMEOUT_MS))) {
    return stream;
  }

  // The stream we still own and must stop if a later hop replaces it.
  let current = stream;
  let retryStream = null;
  try {
    retryStream = await navigator.mediaDevices.getUserMedia(await getFreshConstraints());
    stream.getTracks().forEach((t) => t.stop());
    logger.info("Re-acquired microphone after dead/muted track", {}, "audio");
    current = retryStream;
  } catch (error) {
    logger.warn(
      fallback
        ? "Microphone re-acquire failed, trying the default mic"
        : "Microphone re-acquire failed, using original stream",
      { error: error.message },
      "audio"
    );
    // A retry that cannot even open the device counts as proof it is unusable.
    if (!fallback) return stream;
  }

  if (!fallback) return retryStream;

  // The retry usually resolves back to the same device; a healthy track means it just woke up.
  if (retryStream) {
    const retryTrack = retryStream.getAudioTracks()[0];
    if (retryTrack && (await waitForTrackReady(retryTrack, TRACK_READY_TIMEOUT_MS))) {
      return retryStream;
    }
  }

  fallback.onDeviceRejected();

  let fallbackStream;
  try {
    fallbackStream = await navigator.mediaDevices.getUserMedia(await fallback.getConstraints());
  } catch (error) {
    logger.warn("Microphone fallback failed, no usable input", { error: error.message }, "audio");
    fallback.onFallbackUnusable();
    return current;
  }

  current.getTracks().forEach((t) => t.stop());
  logger.info("Fell back to the default microphone after a silent device", {}, "audio");

  const fallbackTrack = fallbackStream.getAudioTracks()[0];
  if (!fallbackTrack || !(await waitForTrackReady(fallbackTrack, TRACK_READY_TIMEOUT_MS))) {
    fallback.onFallbackUnusable();
  }
  return fallbackStream;
};

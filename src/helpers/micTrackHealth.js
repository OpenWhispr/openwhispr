import { isStaleDeviceError } from "./staleMicDevice.js";

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

const stopStream = (stream) => {
  stream?.getTracks?.().forEach((track) => {
    try {
      track.stop();
    } catch {
      // A track can end between the readiness check and cleanup.
    }
  });
};

const isPermissionError = (error) =>
  error?.name === "NotAllowedError" ||
  error?.name === "PermissionDeniedError" ||
  error?.name === "SecurityError";

const acquireReadyFallback = async (
  getFallbackConstraints,
  logger,
  onFallbackSuccess,
  fallbackContext
) => {
  let fallbackStream;
  try {
    fallbackStream = await navigator.mediaDevices.getUserMedia(await getFallbackConstraints());
  } catch (error) {
    logger.warn("Default microphone fallback failed", { error: error.message }, "audio");
    throw error;
  }

  const fallbackTrack = fallbackStream.getAudioTracks()[0];
  if (fallbackTrack?.muted) {
    logger.debug("Fallback microphone track is muted; waiting for unmute", {}, "audio");
  }

  if (!fallbackTrack || !(await waitForTrackReady(fallbackTrack, TRACK_READY_TIMEOUT_MS))) {
    stopStream(fallbackStream);
    const error = new Error("System default microphone did not become ready");
    error.name = "MicrophoneTrackError";
    logger.warn("Default microphone fallback did not become ready", {}, "audio");
    throw error;
  }

  try {
    onFallbackSuccess?.(fallbackContext);
  } catch (error) {
    stopStream(fallbackStream);
    throw error;
  }

  logger.info("Fallback microphone acquired successfully", {}, "audio");
  return fallbackStream;
};

// Re-acquires the mic once if the preferred capture cannot start or its track never delivers
// audio. getFallbackConstraints must return system-default constraints with no pinned device ID.
// The fallback is health-checked too; a failed fallback is surfaced rather than returning silence.
export const reacquireIfDead = async (
  streamOrPromise,
  getFallbackConstraints,
  logger,
  { fallbackOnAcquisitionError = false, onFallbackSuccess } = {}
) => {
  let stream;
  try {
    stream = await streamOrPromise;
  } catch (error) {
    const canFallback =
      !isPermissionError(error) && (fallbackOnAcquisitionError || isStaleDeviceError(error));
    if (!canFallback) throw error;

    logger.warn(
      "Preferred microphone acquisition failed; falling back to system default",
      { error: error.message },
      "audio"
    );
    return acquireReadyFallback(getFallbackConstraints, logger, onFallbackSuccess, {
      reason: isStaleDeviceError(error) ? "stale-device" : "acquisition-error",
      error,
    });
  }

  const track = stream.getAudioTracks()[0];
  if (track?.muted) {
    logger.debug("Preferred microphone track is muted; waiting for unmute", {}, "audio");
  }
  if (track && (await waitForTrackReady(track, TRACK_READY_TIMEOUT_MS))) {
    return stream;
  }

  const reason = !track ? "missing track" : track.readyState === "ended" ? "ended" : "muted";
  logger.warn(
    "Preferred microphone remained unavailable; falling back to system default",
    { reason },
    "audio"
  );
  logger.debug("Stopping unusable preferred microphone stream", {}, "audio");
  stopStream(stream);
  return acquireReadyFallback(getFallbackConstraints, logger, onFallbackSuccess, { reason });
};

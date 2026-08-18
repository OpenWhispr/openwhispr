const { screen, desktopCapturer, systemPreferences } = require("electron");
const debugLogger = require("./debugLogger");

// Vision models downsample images past ~1.5k px on the long edge; capturing
// larger only inflates the payload without adding model-visible detail.
const MAX_EDGE_PX = 1568;
// A 1568px screenshot lands well under the cap at this quality, so spend the
// headroom on legible on-screen text; the ladder below covers the rare
// near-incompressible screen (video, noise) that doesn't fit.
const QUALITY_LADDER = [82, 70, 55];
// Keeps the base64 payload (~1.37x) inside the API's 2.8M character limit
// with room for the transcript, prompt and dictionary.
const MAX_ENCODED_BYTES = 1_500_000;
const FALLBACK_EDGE_PX = 1024;

// Wayland routes desktopCapturer through the xdg-desktop-portal picker (a
// dialog per capture) and cursor coordinates are unreliable there, so screen
// context is unsupported on Wayland rather than half-broken.
function isWaylandSession() {
  return (
    process.platform === "linux" &&
    ((process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" ||
      !!process.env.WAYLAND_DISPLAY)
  );
}

// macOS applies a Screen Recording grant only at process launch:
// getMediaAccessStatus flips to "granted" the moment the user toggles System
// Settings, but desktopCapturer keeps returning stale/blank frames until the
// app relaunches. Snapshot the first reading to detect mid-session grants.
let launchStatus = null;

function getAccessStatus() {
  if (isWaylandSession()) return "unsupported";
  if (process.platform === "darwin") {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (launchStatus === null) launchStatus = status;
    return status;
  }
  return "granted";
}

function getAccessResult() {
  const status = getAccessStatus();
  return {
    granted: status === "granted",
    status,
    supported: status !== "unsupported",
    needsRelaunch:
      process.platform === "darwin" && status === "granted" && launchStatus !== "granted",
  };
}

// Encodes from the same source bitmap at each step, so lowering quality never
// compounds artifacts from an earlier pass.
function encodeWithinBudget(image) {
  for (const quality of QUALITY_LADDER) {
    const encoded = image.toJPEG(quality);
    if (encoded.length <= MAX_ENCODED_BYTES) return encoded;
  }

  const resized = image.resize({ width: FALLBACK_EDGE_PX, quality: "good" });
  const smallest = resized.toJPEG(QUALITY_LADDER.at(-1));
  return smallest.length <= MAX_ENCODED_BYTES ? smallest : null;
}

// Photographs the display showing the app being dictated into, given that app's
// window rect; without one it falls back to the display under the cursor, which
// on a multi-monitor desk is often not the screen the user is working on.
// Returns null on any failure — a screenshot must never break the dictation
// it accompanies.
async function captureActiveDisplay(targetBounds = null) {
  const accessStatus = getAccessStatus();
  if (accessStatus !== "granted") {
    debugLogger.warn("Screen context capture skipped", { accessStatus }, "screenContext");
    return null;
  }

  try {
    const display = targetBounds
      ? screen.getDisplayMatching(targetBounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(display.size.width, display.size.height));
    const thumbnailSize = {
      width: Math.max(1, Math.round(display.size.width * scale)),
      height: Math.max(1, Math.round(display.size.height * scale)),
    };

    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
    // display_id can be empty on some Linux setups — fall back to the first screen.
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      debugLogger.warn("Screen context capture found no screen source", {}, "screenContext");
      return null;
    }

    const encoded = encodeWithinBudget(source.thumbnail);
    if (!encoded) {
      debugLogger.warn("Screen context too large to send", {}, "screenContext");
      return null;
    }

    return { mediaType: "image/jpeg", data: encoded.toString("base64") };
  } catch (error) {
    debugLogger.warn("Screen context capture failed", { error: error.message }, "screenContext");
    return null;
  }
}

// There is no askForMediaAccess("screen") on macOS; attempting a capture is
// what registers the app in the Screen Recording TCC list and triggers the
// one-time OS prompt.
async function requestAccess() {
  if (process.platform === "darwin" && getAccessStatus() !== "granted") {
    await desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
      .catch(() => {});
  }
  return getAccessStatus();
}

module.exports = { getAccessStatus, getAccessResult, captureActiveDisplay, requestAccess };

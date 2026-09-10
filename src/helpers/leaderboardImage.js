const MAX_LEADERBOARD_PNG_BYTES = 12 * 1024 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

function decodeLeaderboardPngDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error("Leaderboard image must be a PNG data URL");
  }
  const payload = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!payload || payload.length > Math.ceil((MAX_LEADERBOARD_PNG_BYTES * 4) / 3) + 4) {
    throw new Error("Leaderboard image is empty or too large");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    throw new Error("Leaderboard image is not valid base64");
  }
  const image = Buffer.from(payload, "base64");
  if (
    image.length === 0 ||
    image.length > MAX_LEADERBOARD_PNG_BYTES ||
    !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("Leaderboard image is not a valid PNG");
  }
  return image;
}

function leaderboardImageFilename(value) {
  const safe = String(value || "leaderboard.png")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return safe.toLowerCase().endsWith(".png") ? safe : `${safe || "leaderboard"}.png`;
}

module.exports = {
  decodeLeaderboardPngDataUrl,
  leaderboardImageFilename,
};

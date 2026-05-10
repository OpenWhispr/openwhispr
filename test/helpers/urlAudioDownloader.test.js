const test = require("node:test");
const assert = require("node:assert/strict");

const { detectUrlType, extractYouTubeVideoId, isPlaylistUrl } = require("../../src/helpers/urlAudioDownloader");

// --- detectUrlType ---

test("detectUrlType returns youtube for standard watch URL", () => {
  assert.equal(detectUrlType("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube");
});

test("detectUrlType returns youtube for youtu.be short URL", () => {
  assert.equal(detectUrlType("https://youtu.be/dQw4w9WgXcQ"), "youtube");
});

test("detectUrlType returns youtube for Shorts URL", () => {
  assert.equal(detectUrlType("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "youtube");
});

test("detectUrlType returns youtube for Music URL", () => {
  assert.equal(detectUrlType("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube");
});

test("detectUrlType returns youtube for URL with extra params", () => {
  assert.equal(
    detectUrlType("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
    "youtube"
  );
});

test("detectUrlType returns youtube for embed URL", () => {
  assert.equal(detectUrlType("https://www.youtube.com/embed/dQw4w9WgXcQ"), "youtube");
});

test("detectUrlType returns direct for a podcast mp3 URL", () => {
  assert.equal(detectUrlType("https://example.com/episodes/ep42.mp3"), "direct");
});

test("detectUrlType returns direct for any non-YouTube https URL", () => {
  assert.equal(detectUrlType("https://cdn.radio.com/stream.ogg"), "direct");
});

test("detectUrlType throws INVALID_URL for non-http scheme", () => {
  assert.throws(
    () => detectUrlType("ftp://files.example.com/audio.mp3"),
    (err) => err.code === "INVALID_URL"
  );
});

test("detectUrlType throws INVALID_URL for empty string", () => {
  assert.throws(() => detectUrlType(""), (err) => err.code === "INVALID_URL");
});

test("detectUrlType throws INVALID_URL for garbage input", () => {
  assert.throws(() => detectUrlType("not a url at all"), (err) => err.code === "INVALID_URL");
});

// --- extractYouTubeVideoId ---

test("extractYouTubeVideoId extracts from standard watch URL", () => {
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("extractYouTubeVideoId extracts from short URL", () => {
  assert.equal(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("extractYouTubeVideoId extracts from Shorts URL", () => {
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("extractYouTubeVideoId extracts from embed URL", () => {
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("extractYouTubeVideoId extracts from Music URL", () => {
  assert.equal(extractYouTubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("extractYouTubeVideoId returns null for playlist-only URL", () => {
  assert.equal(extractYouTubeVideoId("https://www.youtube.com/playlist?list=PLrAXtmErZgOe"), null);
});

// --- isPlaylistUrl ---

test("isPlaylistUrl returns true for playlist-only URL", () => {
  assert.equal(isPlaylistUrl("https://www.youtube.com/playlist?list=PLrAXtmErZgOe"), true);
});

test("isPlaylistUrl returns false for watch URL with playlist param", () => {
  assert.equal(isPlaylistUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOe"), false);
});

test("isPlaylistUrl returns false for non-YouTube URL", () => {
  assert.equal(isPlaylistUrl("https://example.com/playlist"), false);
});

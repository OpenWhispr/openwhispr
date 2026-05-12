const test = require("node:test");
const assert = require("node:assert/strict");

const { detectUrlType, extractYouTubeVideoId, isPlaylistUrl, isPrivateIp, ssrfSafeLookup } = require("../../src/helpers/urlAudioDownloader");

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

// --- isPrivateIp ---

test("isPrivateIp blocks loopback 127.x.x.x", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("127.255.255.255"), true);
});

test("isPrivateIp blocks 10.x.x.x", () => {
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("10.255.255.255"), true);
});

test("isPrivateIp blocks 172.16-31.x.x", () => {
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("172.31.255.255"), true);
  assert.equal(isPrivateIp("172.15.0.1"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false);
});

test("isPrivateIp blocks 192.168.x.x", () => {
  assert.equal(isPrivateIp("192.168.0.1"), true);
  assert.equal(isPrivateIp("192.168.255.255"), true);
});

test("isPrivateIp blocks link-local 169.254.x.x", () => {
  assert.equal(isPrivateIp("169.254.169.254"), true);
});

test("isPrivateIp blocks 0.0.0.0/8 (this network)", () => {
  assert.equal(isPrivateIp("0.0.0.0"), true);
  assert.equal(isPrivateIp("0.1.2.3"), true);
});

test("isPrivateIp blocks CGNAT 100.64-127.x.x", () => {
  assert.equal(isPrivateIp("100.64.0.1"), true);
  assert.equal(isPrivateIp("100.127.255.255"), true);
  assert.equal(isPrivateIp("100.63.0.1"), false);
  assert.equal(isPrivateIp("100.128.0.1"), false);
});

test("isPrivateIp blocks multicast and reserved (224+)", () => {
  assert.equal(isPrivateIp("224.0.0.1"), true);
  assert.equal(isPrivateIp("240.0.0.1"), true);
  assert.equal(isPrivateIp("255.255.255.255"), true);
});

test("isPrivateIp allows public IPs", () => {
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("1.1.1.1"), false);
  assert.equal(isPrivateIp("203.0.113.1"), false);
});

test("isPrivateIp blocks IPv6 loopback and unspecified", () => {
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("::"), true);
});

test("isPrivateIp blocks IPv6 unique local (fc/fd)", () => {
  assert.equal(isPrivateIp("fc00::1"), true);
  assert.equal(isPrivateIp("fd12:3456::1"), true);
});

test("isPrivateIp blocks IPv6 link-local (fe80)", () => {
  assert.equal(isPrivateIp("fe80::1"), true);
});

test("isPrivateIp blocks IPv6 multicast (ff)", () => {
  assert.equal(isPrivateIp("ff02::1"), true);
});

test("isPrivateIp blocks IPv4-mapped IPv6", () => {
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:169.254.169.254"), true);
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});

test("isPrivateIp blocks IPv4-compatible IPv6", () => {
  assert.equal(isPrivateIp("::127.0.0.1"), true);
  assert.equal(isPrivateIp("::10.0.0.1"), true);
  assert.equal(isPrivateIp("::8.8.8.8"), false);
});

// --- ssrfSafeLookup ---

test("ssrfSafeLookup rejects private IPs via callback", (t, done) => {
  const fakeLookup = (hostname, opts, cb) => cb(null, "127.0.0.1", 4);
  const original = require("dns").lookup;
  require("dns").lookup = fakeLookup;
  ssrfSafeLookup("evil.com", {}, (err) => {
    require("dns").lookup = original;
    assert.ok(err);
    assert.equal(err.code, "SSRF_BLOCKED");
    done();
  });
});

test("ssrfSafeLookup allows public IPs via callback", (t, done) => {
  const fakeLookup = (hostname, opts, cb) => cb(null, "93.184.216.34", 4);
  const original = require("dns").lookup;
  require("dns").lookup = fakeLookup;
  ssrfSafeLookup("example.com", {}, (err, address) => {
    require("dns").lookup = original;
    assert.equal(err, null);
    assert.equal(address, "93.184.216.34");
    done();
  });
});

// --- extractYouTubeVideoId youtu.be validation ---

test("extractYouTubeVideoId rejects youtu.be with non-standard ID", () => {
  assert.equal(extractYouTubeVideoId("https://youtu.be/x%25(home)s"), null);
  assert.equal(extractYouTubeVideoId("https://youtu.be/short"), null);
  assert.equal(extractYouTubeVideoId("https://youtu.be/toolongvideoiddd"), null);
});

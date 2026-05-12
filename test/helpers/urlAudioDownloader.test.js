import { it, expect } from "vitest";
import dns from "dns";
import { detectUrlType, extractYouTubeVideoId, isPlaylistUrl, isPrivateIp, ssrfSafeLookup } from "../../src/helpers/urlAudioDownloader";

it("detectUrlType returns youtube for standard watch URL", () => {
  expect(detectUrlType("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
});

it("detectUrlType returns youtube for youtu.be short URL", () => {
  expect(detectUrlType("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
});

it("detectUrlType returns youtube for Shorts URL", () => {
  expect(detectUrlType("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("youtube");
});

it("detectUrlType returns youtube for Music URL", () => {
  expect(detectUrlType("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
});

it("detectUrlType returns youtube for URL with extra params", () => {
  expect(
    detectUrlType("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf")
  ).toBe("youtube");
});

it("detectUrlType returns youtube for embed URL", () => {
  expect(detectUrlType("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("youtube");
});

it("detectUrlType returns direct for a podcast mp3 URL", () => {
  expect(detectUrlType("https://example.com/episodes/ep42.mp3")).toBe("direct");
});

it("detectUrlType returns direct for any non-YouTube https URL", () => {
  expect(detectUrlType("https://cdn.radio.com/stream.ogg")).toBe("direct");
});

it("detectUrlType throws INVALID_URL for non-http scheme", () => {
  expect(() => detectUrlType("ftp://files.example.com/audio.mp3")).toThrow();
  try {
    detectUrlType("ftp://files.example.com/audio.mp3");
  } catch (err) {
    expect(err.code).toBe("INVALID_URL");
  }
});

it("detectUrlType throws INVALID_URL for empty string", () => {
  expect(() => detectUrlType("")).toThrow();
  try {
    detectUrlType("");
  } catch (err) {
    expect(err.code).toBe("INVALID_URL");
  }
});

it("detectUrlType throws INVALID_URL for garbage input", () => {
  expect(() => detectUrlType("not a url at all")).toThrow();
  try {
    detectUrlType("not a url at all");
  } catch (err) {
    expect(err.code).toBe("INVALID_URL");
  }
});

it("extractYouTubeVideoId extracts from standard watch URL", () => {
  expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

it("extractYouTubeVideoId extracts from short URL", () => {
  expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

it("extractYouTubeVideoId extracts from Shorts URL", () => {
  expect(extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

it("extractYouTubeVideoId extracts from embed URL", () => {
  expect(extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

it("extractYouTubeVideoId extracts from Music URL", () => {
  expect(extractYouTubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

it("extractYouTubeVideoId returns null for playlist-only URL", () => {
  expect(extractYouTubeVideoId("https://www.youtube.com/playlist?list=PLrAXtmErZgOe")).toBeNull();
});

it("isPlaylistUrl returns true for playlist-only URL", () => {
  expect(isPlaylistUrl("https://www.youtube.com/playlist?list=PLrAXtmErZgOe")).toBe(true);
});

it("isPlaylistUrl returns false for watch URL with playlist param", () => {
  expect(isPlaylistUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOe")).toBe(false);
});

it("isPlaylistUrl returns false for non-YouTube URL", () => {
  expect(isPlaylistUrl("https://example.com/playlist")).toBe(false);
});

it("isPrivateIp blocks loopback 127.x.x.x", () => {
  expect(isPrivateIp("127.0.0.1")).toBe(true);
  expect(isPrivateIp("127.255.255.255")).toBe(true);
});

it("isPrivateIp blocks 10.x.x.x", () => {
  expect(isPrivateIp("10.0.0.1")).toBe(true);
  expect(isPrivateIp("10.255.255.255")).toBe(true);
});

it("isPrivateIp blocks 172.16-31.x.x", () => {
  expect(isPrivateIp("172.16.0.1")).toBe(true);
  expect(isPrivateIp("172.31.255.255")).toBe(true);
  expect(isPrivateIp("172.15.0.1")).toBe(false);
  expect(isPrivateIp("172.32.0.1")).toBe(false);
});

it("isPrivateIp blocks 192.168.x.x", () => {
  expect(isPrivateIp("192.168.0.1")).toBe(true);
  expect(isPrivateIp("192.168.255.255")).toBe(true);
});

it("isPrivateIp blocks link-local 169.254.x.x", () => {
  expect(isPrivateIp("169.254.169.254")).toBe(true);
});

it("isPrivateIp blocks 0.0.0.0/8 (this network)", () => {
  expect(isPrivateIp("0.0.0.0")).toBe(true);
  expect(isPrivateIp("0.1.2.3")).toBe(true);
});

it("isPrivateIp blocks CGNAT 100.64-127.x.x", () => {
  expect(isPrivateIp("100.64.0.1")).toBe(true);
  expect(isPrivateIp("100.127.255.255")).toBe(true);
  expect(isPrivateIp("100.63.0.1")).toBe(false);
  expect(isPrivateIp("100.128.0.1")).toBe(false);
});

it("isPrivateIp blocks multicast and reserved (224+)", () => {
  expect(isPrivateIp("224.0.0.1")).toBe(true);
  expect(isPrivateIp("240.0.0.1")).toBe(true);
  expect(isPrivateIp("255.255.255.255")).toBe(true);
});

it("isPrivateIp allows public IPs", () => {
  expect(isPrivateIp("8.8.8.8")).toBe(false);
  expect(isPrivateIp("1.1.1.1")).toBe(false);
  expect(isPrivateIp("203.0.113.1")).toBe(false);
});

it("isPrivateIp blocks IPv6 loopback and unspecified", () => {
  expect(isPrivateIp("::1")).toBe(true);
  expect(isPrivateIp("::")).toBe(true);
});

it("isPrivateIp blocks IPv6 unique local (fc/fd)", () => {
  expect(isPrivateIp("fc00::1")).toBe(true);
  expect(isPrivateIp("fd12:3456::1")).toBe(true);
});

it("isPrivateIp blocks IPv6 link-local (fe80)", () => {
  expect(isPrivateIp("fe80::1")).toBe(true);
});

it("isPrivateIp blocks IPv6 multicast (ff)", () => {
  expect(isPrivateIp("ff02::1")).toBe(true);
});

it("isPrivateIp blocks IPv4-mapped IPv6", () => {
  expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
  expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
  expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
  expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
});

it("isPrivateIp blocks IPv4-compatible IPv6", () => {
  expect(isPrivateIp("::127.0.0.1")).toBe(true);
  expect(isPrivateIp("::10.0.0.1")).toBe(true);
  expect(isPrivateIp("::8.8.8.8")).toBe(false);
});

it("ssrfSafeLookup rejects private IPs via callback", () => {
  return new Promise((resolve, reject) => {
    const original = dns.lookup;
    dns.lookup = (_hostname, _opts, cb) => cb(null, "127.0.0.1", 4);
    ssrfSafeLookup("evil.com", {}, (err) => {
      dns.lookup = original;
      try {
        expect(err).toBeTruthy();
        expect(err.code).toBe("SSRF_BLOCKED");
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

it("ssrfSafeLookup allows public IPs via callback", () => {
  return new Promise((resolve, reject) => {
    const original = dns.lookup;
    dns.lookup = (_hostname, _opts, cb) => cb(null, "93.184.216.34", 4);
    ssrfSafeLookup("example.com", {}, (err, address) => {
      dns.lookup = original;
      try {
        expect(err).toBeNull();
        expect(address).toBe("93.184.216.34");
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

it("extractYouTubeVideoId rejects youtu.be with non-standard ID", () => {
  expect(extractYouTubeVideoId("https://youtu.be/x%25(home)s")).toBeNull();
  expect(extractYouTubeVideoId("https://youtu.be/short")).toBeNull();
  expect(extractYouTubeVideoId("https://youtu.be/toolongvideoiddd")).toBeNull();
});

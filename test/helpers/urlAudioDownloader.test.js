const test = require("node:test");
const assert = require("node:assert/strict");
const dns = require("dns");
const childProcess = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
// Isolate the yt-dlp self-update cache in a temp dir so tests never touch the
// real ~/.cache/openwhispr. Must be set before the module is required.
const YT_DLP_TEST_CACHE_DIR = path.join(os.tmpdir(), `ow-ytdlp-test-${process.pid}`);
process.env.OPENWHISPR_YTDLP_CACHE_DIR = YT_DLP_TEST_CACHE_DIR;
const downloader = require("../../src/helpers/urlAudioDownloader");
const {
  detectUrlType,
  extractYouTubeVideoId,
  isPlaylistUrl,
  isPrivateIp,
  isAcceptableAudioContentType,
  ssrfSafeLookup,
  maybeUpdateYtDlp,
} = downloader;

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
  assert.throws(() => detectUrlType("ftp://files.example.com/audio.mp3"));
  try {
    detectUrlType("ftp://files.example.com/audio.mp3");
  } catch (err) {
    assert.equal(err.code, "INVALID_URL");
  }
});

test("detectUrlType throws INVALID_URL for empty string", () => {
  assert.throws(() => detectUrlType(""));
  try {
    detectUrlType("");
  } catch (err) {
    assert.equal(err.code, "INVALID_URL");
  }
});

test("detectUrlType throws INVALID_URL for garbage input", () => {
  assert.throws(() => detectUrlType("not a url at all"));
  try {
    detectUrlType("not a url at all");
  } catch (err) {
    assert.equal(err.code, "INVALID_URL");
  }
});

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

test("isPlaylistUrl returns true for playlist-only URL", () => {
  assert.equal(isPlaylistUrl("https://www.youtube.com/playlist?list=PLrAXtmErZgOe"), true);
});

test("isPlaylistUrl returns false for watch URL with playlist param", () => {
  assert.equal(isPlaylistUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOe"), false);
});

test("isPlaylistUrl returns false for non-YouTube URL", () => {
  assert.equal(isPlaylistUrl("https://example.com/playlist"), false);
});

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

test("isPrivateIp blocks NAT64 (64:ff9b::/96) with private embedded IPv4", () => {
  // hex-embedded forms
  assert.equal(isPrivateIp("64:ff9b::a00:1"), true); // 10.0.0.1
  assert.equal(isPrivateIp("64:ff9b::c0a8:101"), true); // 192.168.1.1
  // dotted-embedded form
  assert.equal(isPrivateIp("64:ff9b::10.0.0.1"), true);
  assert.equal(isPrivateIp("64:ff9b::192.168.1.1"), true);
});

test("isPrivateIp allows NAT64 (64:ff9b::/96) with public embedded IPv4", () => {
  assert.equal(isPrivateIp("64:ff9b::8.8.8.8"), false);
  assert.equal(isPrivateIp("64:ff9b::808:808"), false); // 8.8.8.8 in hex
});

test("isPrivateIp blocks zero-padded NAT64 prefix (0064:ff9b)", () => {
  assert.equal(isPrivateIp("0064:ff9b::a00:1"), true); // 10.0.0.1
  assert.equal(isPrivateIp("0064:ff9b::c0a8:101"), true); // 192.168.1.1
  assert.equal(isPrivateIp("0064:ff9b::10.0.0.1"), true);
});

test("isPrivateIp allows zero-padded NAT64 prefix with public embedded IPv4", () => {
  assert.equal(isPrivateIp("0064:ff9b::808:808"), false); // 8.8.8.8
});

test("isPrivateIp blocks fully-expanded IPv4-mapped loopback/private", () => {
  assert.equal(isPrivateIp("0:0:0:0:0:ffff:7f00:1"), true); // 127.0.0.1
  assert.equal(isPrivateIp("0000:0000:0000:0000:0000:ffff:7f00:0001"), true); // 127.0.0.1
  assert.equal(isPrivateIp("0:0:0:0:0:ffff:a00:1"), true); // 10.0.0.1
  assert.equal(isPrivateIp("0:0:0:0:0:ffff:a9fe:a9fe"), true); // 169.254.169.254
});

test("isPrivateIp allows fully-expanded IPv4-mapped public address", () => {
  assert.equal(isPrivateIp("0:0:0:0:0:ffff:808:808"), false); // 8.8.8.8
});

test("isPrivateIp blocks fully-expanded IPv4-mapped with dotted tail", () => {
  assert.equal(isPrivateIp("0:0:0:0:0:ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("0:0:0:0:0:ffff:169.254.169.254"), true);
  assert.equal(isPrivateIp("0:0:0:0:0:ffff:8.8.8.8"), false);
});

test("isAcceptableAudioContentType accepts audio and video, rejects octet-stream and html", () => {
  assert.equal(isAcceptableAudioContentType("audio/mpeg"), true);
  assert.equal(isAcceptableAudioContentType("video/mp4"), true);
  assert.equal(isAcceptableAudioContentType("AUDIO/MPEG"), true);
  assert.equal(isAcceptableAudioContentType("application/octet-stream"), false);
  assert.equal(isAcceptableAudioContentType("text/html"), false);
  assert.equal(isAcceptableAudioContentType(""), false);
  assert.equal(isAcceptableAudioContentType(undefined), false);
});

test("ssrfSafeLookup rejects private IPs via callback", () => {
  return new Promise((resolve, reject) => {
    const original = dns.lookup;
    dns.lookup = (_hostname, _opts, cb) => cb(null, "127.0.0.1", 4);
    ssrfSafeLookup("evil.com", {}, (err) => {
      dns.lookup = original;
      try {
        assert.ok(err);
        assert.equal(err.code, "SSRF_BLOCKED");
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test("ssrfSafeLookup allows public IPs via callback", () => {
  return new Promise((resolve, reject) => {
    const original = dns.lookup;
    dns.lookup = (_hostname, _opts, cb) => cb(null, "93.184.216.34", 4);
    ssrfSafeLookup("example.com", {}, (err, address) => {
      dns.lookup = original;
      try {
        assert.equal(err, null);
        assert.equal(address, "93.184.216.34");
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

// Regression: Happy Eyeballs / autoSelectFamily calls lookup with { all: true },
// so dns.lookup returns an ARRAY. The old single-value check let private IPs through.
test("ssrfSafeLookup blocks a private IP in the all:true array form", () => {
  return new Promise((resolve, reject) => {
    const original = dns.lookup;
    dns.lookup = (_hostname, _opts, cb) =>
      cb(null, [{ address: "169.254.169.254", family: 4 }]);
    try {
      ssrfSafeLookup("metadata.evil.com", { all: true }, (err) => {
        dns.lookup = original;
        try {
          assert.ok(err);
          assert.equal(err.code, "SSRF_BLOCKED");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      dns.lookup = original;
      reject(e);
    }
  });
});

test("ssrfSafeLookup forwards an all-public array unchanged", () => {
  return new Promise((resolve, reject) => {
    const original = dns.lookup;
    const arr = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ];
    dns.lookup = (_hostname, _opts, cb) => cb(null, arr);
    try {
      ssrfSafeLookup("example.com", { all: true }, (err, address) => {
        dns.lookup = original;
        try {
          assert.equal(err, null);
          assert.deepEqual(address, arr);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      dns.lookup = original;
      reject(e);
    }
  });
});

test("ssrfSafeLookup blocks one private entry mixed into a public array", () => {
  return new Promise((resolve, reject) => {
    const original = dns.lookup;
    dns.lookup = (_hostname, _opts, cb) =>
      cb(null, [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]);
    try {
      ssrfSafeLookup("rebind.evil.com", { all: true }, (err) => {
        dns.lookup = original;
        try {
          assert.ok(err);
          assert.equal(err.code, "SSRF_BLOCKED");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      dns.lookup = original;
      reject(e);
    }
  });
});

test("ssrfSafeLookup still blocks the legacy single-string private form", () => {
  return new Promise((resolve, reject) => {
    const original = dns.lookup;
    dns.lookup = (_hostname, _opts, cb) => cb(null, "127.0.0.1", 4);
    try {
      ssrfSafeLookup("evil.com", {}, (err) => {
        dns.lookup = original;
        try {
          assert.ok(err);
          assert.equal(err.code, "SSRF_BLOCKED");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      dns.lookup = original;
      reject(e);
    }
  });
});

test("extractYouTubeVideoId rejects youtu.be with non-standard ID", () => {
  assert.equal(extractYouTubeVideoId("https://youtu.be/x%25(home)s"), null);
  assert.equal(extractYouTubeVideoId("https://youtu.be/short"), null);
  assert.equal(extractYouTubeVideoId("https://youtu.be/toolongvideoiddd"), null);
});

// --- maybeUpdateYtDlp self-update: hang/leak regression (FIX A) ---

// A fake child that never emits close/exit, with a kill() that records the call.
function makeFakeChild() {
  const child = new EventEmitter();
  child.killCalled = false;
  child.kill = () => { child.killCalled = true; return true; };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// Reject if the promise hasn't settled within ms, so a real hang fails loudly
// instead of relying on the test runner's global timeout.
async function resolvesWithin(promise, ms) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not resolve within ${ms}ms`)), ms);
  });
  try {
    await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

// Ensure the writable cache binary exists so maybeUpdateYtDlp reaches the spawn
// path (it short-circuits when the cache copy is missing). Operates in the
// isolated test cache dir; the cleanup fn removes that whole dir.
function ensureCacheBinary() {
  const cacheDir = YT_DLP_TEST_CACHE_DIR;
  const name = `yt-dlp-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  const binPath = path.join(cacheDir, name);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(binPath, "#!/bin/sh\n");
  try { fs.chmodSync(binPath, 0o755); } catch {}
  return () => {
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
  };
}

test("maybeUpdateYtDlp resolves on -U timeout, kills the child, and clears the in-flight flag", async () => {
  const cleanup = ensureCacheBinary();
  const origSpawn = childProcess.spawn;
  let spawnCount = 0;
  let lastChild = null;
  childProcess.spawn = () => {
    spawnCount += 1;
    lastChild = makeFakeChild();
    return lastChild;
  };
  try {
    await resolvesWithin(maybeUpdateYtDlp({ force: true, timeoutMs: 20 }), 2000);
    assert.ok(lastChild.killCalled, "timeout should have killed the stuck child");
    assert.equal(downloader._isYtDlpUpdateInFlight(), false, "in-flight flag must be cleared");
    assert.equal(spawnCount, 1);

    // A stuck flag would make this second call short-circuit without spawning.
    await resolvesWithin(maybeUpdateYtDlp({ force: true, timeoutMs: 20 }), 2000);
    assert.equal(spawnCount, 2, "second call must spawn again, proving no stuck single-flight flag");
    assert.equal(downloader._isYtDlpUpdateInFlight(), false);
  } finally {
    childProcess.spawn = origSpawn;
    cleanup();
  }
});

test("maybeUpdateYtDlp with an already-aborted signal resolves promptly and kills the child", async () => {
  const cleanup = ensureCacheBinary();
  const origSpawn = childProcess.spawn;
  let lastChild = null;
  childProcess.spawn = () => {
    lastChild = makeFakeChild();
    return lastChild;
  };
  const ac = new AbortController();
  ac.abort();
  try {
    await resolvesWithin(
      maybeUpdateYtDlp({ force: true, abortSignal: ac.signal, timeoutMs: 60000 }),
      2000
    );
    assert.ok(lastChild.killCalled, "abort should have killed the child");
    assert.equal(downloader._isYtDlpUpdateInFlight(), false, "in-flight flag must be cleared");
  } finally {
    childProcess.spawn = origSpawn;
    cleanup();
  }
});

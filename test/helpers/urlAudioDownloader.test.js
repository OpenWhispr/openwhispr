const test = require("node:test");
const assert = require("node:assert/strict");
const dns = require("dns");
const childProcess = require("child_process");
const { EventEmitter } = require("events");
const { Readable } = require("stream");
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

// --- downloadViaProxy: redirect handling regression ---
//
// Electron requires request.followRedirect()/request.abort() to be invoked
// synchronously from inside the "redirect" event. downloadViaProxy instead
// aborts and rejects with a REDIRECT_RESTART sentinel, then recurses on the
// redirect URL (re-running assertPublicHost). These fakes emit their events
// from inside request.end(), which runs after all request.on() listeners are
// attached in the source, matching real net.request() ordering.

function makeFakeProxyRequest() {
  const req = new EventEmitter();
  req.abortCalled = false;
  req.followRedirectCalled = false;
  req.abort = () => { req.abortCalled = true; };
  req.followRedirect = () => { req.followRedirectCalled = true; };
  req.setHeader = () => {};
  req.end = () => {};
  return req;
}

function makeAudioResponse(body) {
  const response = Readable.from([Buffer.from(body)]);
  response.statusCode = 200;
  response.headers = { "content-type": "audio/mpeg", "content-length": String(body.length) };
  return response;
}

test("downloadViaProxy restarts on redirect via abort, never calls followRedirect, and ignores a late error", async () => {
  const requests = [];
  const fakeNet = {
    request(options) {
      const req = makeFakeProxyRequest();
      req.url = options.url;
      requests.push(req);
      req.end = () => {
        if (requests.length === 1) {
          req.emit("redirect", 302, "GET", "https://93.184.216.34/real.mp3");
          // Late error after the abort must be a no-op: the promise already settled.
          req.emit("error", new Error("stale socket error"));
        } else {
          req.emit("response", makeAudioResponse("audiodata"));
        }
      };
      return req;
    },
  };

  downloader._setElectronNetForTests(fakeNet);
  let tempPath;
  try {
    const result = await downloader.downloadViaProxy("https://93.184.216.34/file.mp3", null, null);
    tempPath = result.tempPath;
    assert.equal(fs.readFileSync(tempPath, "utf8"), "audiodata");
    assert.equal(requests.length, 2, "must restart with a fresh request, not follow in place");
    assert.equal(requests[0].url, "https://93.184.216.34/file.mp3");
    assert.equal(requests[1].url, "https://93.184.216.34/real.mp3", "restart must target the redirect URL");
    assert.equal(requests[0].abortCalled, true);
    assert.equal(requests[0].followRedirectCalled, false);
    assert.equal(requests[1].followRedirectCalled, false);
  } finally {
    downloader._setElectronNetForTests(null);
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch {} }
  }
});

test("downloadViaProxy rejects a redirect to a private IP with SSRF_BLOCKED", async () => {
  const requests = [];
  const fakeNet = {
    request(options) {
      const req = makeFakeProxyRequest();
      req.url = options.url;
      requests.push(req);
      req.end = () => {
        req.emit("redirect", 302, "GET", "https://127.0.0.1/x.mp3");
      };
      return req;
    },
  };

  downloader._setElectronNetForTests(fakeNet);
  try {
    await assert.rejects(
      downloader.downloadViaProxy("https://93.184.216.34/file.mp3", null, null),
      { code: "SSRF_BLOCKED" }
    );
    assert.equal(requests.length, 1, "must not re-request a redirect target rejected by assertPublicHost");
  } finally {
    downloader._setElectronNetForTests(null);
  }
});

test("downloadViaProxy rejects a non-https redirect with INVALID_URL", async () => {
  const requests = [];
  const fakeNet = {
    request(options) {
      const req = makeFakeProxyRequest();
      req.url = options.url;
      requests.push(req);
      req.end = () => {
        req.emit("redirect", 302, "GET", "http://93.184.216.34/x.mp3");
      };
      return req;
    },
  };

  downloader._setElectronNetForTests(fakeNet);
  try {
    await assert.rejects(
      downloader.downloadViaProxy("https://93.184.216.34/file.mp3", null, null),
      { code: "INVALID_URL" }
    );
    assert.equal(requests.length, 1);
  } finally {
    downloader._setElectronNetForTests(null);
  }
});

test("downloadViaProxy fails with DOWNLOAD_FAILED after exceeding MAX_REDIRECTS", async () => {
  const requests = [];
  const fakeNet = {
    request(options) {
      const req = makeFakeProxyRequest();
      req.url = options.url;
      requests.push(req);
      req.end = () => {
        req.emit("redirect", 302, "GET", "https://93.184.216.34/next.mp3");
      };
      return req;
    },
  };

  downloader._setElectronNetForTests(fakeNet);
  try {
    await assert.rejects(
      downloader.downloadViaProxy("https://93.184.216.34/file.mp3", null, null),
      (err) => {
        assert.equal(err.code, "DOWNLOAD_FAILED");
        assert.match(err.message, /Too many redirects/);
        return true;
      }
    );
    // MAX_REDIRECTS is 3 in urlAudioDownloader.js; the 4th redirect trips the limit.
    assert.equal(requests.length, 4);
  } finally {
    downloader._setElectronNetForTests(null);
  }
});

test("downloadViaProxy rejects with DOWNLOAD_CANCELLED on mid-flight abort", async () => {
  const requests = [];
  const fakeNet = {
    // A request that emits nothing: no redirect, no response, no error. abort()
    // only records the call, matching ClientRequest.abort() (never emits 'error').
    request(options) {
      const req = makeFakeProxyRequest();
      req.url = options.url;
      requests.push(req);
      return req;
    },
  };

  downloader._setElectronNetForTests(fakeNet);
  const ac = new AbortController();
  try {
    const promise = downloader.downloadViaProxy("https://93.184.216.34/file.mp3", null, ac.signal);
    // Abort after the synchronous setup (assertPublicHost + request.end()) has run.
    setImmediate(() => ac.abort());
    await assert.rejects(promise, { code: "DOWNLOAD_CANCELLED" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].abortCalled, true, "abort() must be called on the in-flight request");
  } finally {
    downloader._setElectronNetForTests(null);
  }
});

// --- selectYtDlpOutput: finished-file selection + transient cleanup ---

function mkSelectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ow-ytdlp-select-"));
}

// Create a prefix-matched file with a fixed mtime (seconds) to make ordering deterministic.
function writeAt(dir, name, mtimeSeconds) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x");
  fs.utimesSync(p, mtimeSeconds, mtimeSeconds);
  return p;
}

test("selectYtDlpOutput picks the finished file over a longer-named .part leftover", () => {
  const dir = mkSelectDir();
  const prefix = "ow-url-1-abc";
  try {
    writeAt(dir, `${prefix}.m4a`, 1700000000);
    writeAt(dir, `${prefix}.m4a.part`, 1700000500);
    const selected = downloader._selectYtDlpOutput(dir, prefix);
    assert.equal(selected, path.join(dir, `${prefix}.m4a`));
    assert.equal(fs.existsSync(selected), true);
    assert.equal(fs.existsSync(path.join(dir, `${prefix}.m4a.part`)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("selectYtDlpOutput prefers the finished file over a newer .fNNN intermediate (tier beats mtime)", () => {
  const dir = mkSelectDir();
  const prefix = "ow-url-2-abc";
  try {
    writeAt(dir, `${prefix}.m4a`, 1700000000);
    writeAt(dir, `${prefix}.f140.m4a`, 1700000500);
    const selected = downloader._selectYtDlpOutput(dir, prefix);
    assert.equal(selected, path.join(dir, `${prefix}.m4a`));
    assert.equal(fs.existsSync(path.join(dir, `${prefix}.f140.m4a`)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("selectYtDlpOutput picks the newest of two equal-tier audio files", () => {
  const dir = mkSelectDir();
  const prefix = "ow-url-3-abc";
  try {
    writeAt(dir, `${prefix}.m4a`, 1700000000);
    writeAt(dir, `${prefix}.opus`, 1700000500);
    const selected = downloader._selectYtDlpOutput(dir, prefix);
    assert.equal(selected, path.join(dir, `${prefix}.opus`));
    assert.equal(fs.existsSync(path.join(dir, `${prefix}.m4a`)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("selectYtDlpOutput throws DOWNLOAD_FAILED when only transients remain", () => {
  const dir = mkSelectDir();
  const prefix = "ow-url-4-abc";
  try {
    writeAt(dir, `${prefix}.m4a.part`, 1700000000);
    writeAt(dir, `${prefix}.ytdl`, 1700000500);
    assert.throws(
      () => downloader._selectYtDlpOutput(dir, prefix),
      (err) => {
        assert.equal(err.code, "DOWNLOAD_FAILED");
        assert.equal(err.message, "Download produced no output");
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("selectYtDlpOutput keeps only the selected file and deletes every other prefix match", () => {
  const dir = mkSelectDir();
  const prefix = "ow-url-5-abc";
  try {
    const others = [
      `${prefix}.m4a.part`,
      `${prefix}.temp.m4a`,
      `${prefix}.f140.m4a.part`,
      `${prefix}.m4a.ytdl`,
      `${prefix}.f251.webm`,
    ];
    writeAt(dir, `${prefix}.m4a`, 1700000000);
    for (const name of others) writeAt(dir, name, 1700000500);
    const selected = downloader._selectYtDlpOutput(dir, prefix);
    assert.equal(selected, path.join(dir, `${prefix}.m4a`));
    assert.equal(fs.existsSync(selected), true);
    for (const name of others) {
      assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} should have been deleted`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("selectYtDlpOutput excludes a .temp. infix file even when it is newer", () => {
  const dir = mkSelectDir();
  const prefix = "ow-url-6-abc";
  try {
    writeAt(dir, `${prefix}.temp.m4a`, 1700000500);
    writeAt(dir, `${prefix}.m4a`, 1700000000);
    const selected = downloader._selectYtDlpOutput(dir, prefix);
    assert.equal(selected, path.join(dir, `${prefix}.m4a`));
    assert.equal(fs.existsSync(path.join(dir, `${prefix}.temp.m4a`)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("selectYtDlpOutput excludes -Frag fragment files", () => {
  const dir = mkSelectDir();
  const prefix = "ow-url-7-abc";
  try {
    writeAt(dir, `${prefix}.m4a.part-Frag3`, 1700000500);
    writeAt(dir, `${prefix}.m4a`, 1700000000);
    const selected = downloader._selectYtDlpOutput(dir, prefix);
    assert.equal(selected, path.join(dir, `${prefix}.m4a`));
    assert.equal(fs.existsSync(path.join(dir, `${prefix}.m4a.part-Frag3`)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

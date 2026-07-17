const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveWindowsPausePath } = require("../../src/helpers/mediaPlayerPausePath");

test("GSMTC success with paused apps uses gsmtc path", () => {
  assert.equal(
    resolveWindowsPausePath({
      status: 0,
      output: "Plex.exe|Spotify.exe",
      mediaKeyFallback: false,
    }),
    "gsmtc"
  );
});

test("GSMTC_FAIL always falls back to media key", () => {
  assert.equal(
    resolveWindowsPausePath({
      status: 0,
      output: "GSMTC_FAIL",
      mediaKeyFallback: false,
    }),
    "fallback"
  );
});

test("PowerShell failure always falls back to media key", () => {
  assert.equal(
    resolveWindowsPausePath({
      status: 1,
      output: "",
      mediaKeyFallback: false,
    }),
    "fallback"
  );
});

test("empty GSMTC sessions are a noop without mediaKeyFallback (#993)", () => {
  assert.equal(
    resolveWindowsPausePath({
      status: 0,
      output: "",
      mediaKeyFallback: false,
    }),
    "noop"
  );
});

test("empty GSMTC sessions fall back when mediaKeyFallback is on (#993)", () => {
  assert.equal(
    resolveWindowsPausePath({
      status: 0,
      output: "",
      mediaKeyFallback: true,
    }),
    "fallback"
  );
});

test("whitespace-only GSMTC output is treated as empty sessions", () => {
  assert.equal(
    resolveWindowsPausePath({
      status: 0,
      output: "   \n",
      mediaKeyFallback: true,
    }),
    "fallback"
  );
});

#!/usr/bin/env node
// Backend/operator smoke test. Prints scores and timing, never credentials or text.
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const { setTimeout: wait } = require("node:timers/promises");
const { OrukeetStreaming, MANAGED_STREAM_OPTIONS } = require("../src/helpers/orukeetStreaming");
const BASE = "https://orukeet.gizmovoice.ai/preview/language-routing";

async function main() {
  const file = process.argv[2];
  const key = process.env.ORUKEET_SERVICE_KEY?.trim();
  if (!file || process.argv.length !== 3 || !key) {
    throw new Error(
      "Set ORUKEET_SERVICE_KEY, then run: node scripts/preview-orukeet-language.cjs recording.pcm"
    );
  }
  const size = fs.statSync(file).size;
  if (!size || size % 2 || size > 120 * 32000) {
    throw new Error("Expected at most 120 s of signed 16-bit little-endian mono 16 kHz PCM");
  }
  const pcm = fs.readFileSync(file);
  if (pcm.subarray(0, 4).toString() === "RIFF") {
    throw new Error("Convert WAV to raw PCM first; see docs/orukeet-streaming-language.md");
  }
  const response = await fetch(`${BASE}/v1/client-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(
      process.env.ORUKEET_ACCOUNT_ID
        ? { account_id: process.env.ORUKEET_ACCOUNT_ID, socket_role: "active" }
        : {}
    ),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Token mint returned HTTP ${response.status}`);
  const { token } = await response.json();
  if (typeof token !== "string" || !token) throw new Error("Token mint returned no token");
  const stream = new OrukeetStreaming(MANAGED_STREAM_OPTIONS);
  const hints = [];
  stream.onLanguage = (value) =>
    hints.push({
      language: value.language,
      topScore: value.languageConfidence,
      supportedScore: value.languageSupportedScore ?? null,
      analyzedSeconds: value.languageAudioSeconds,
    });
  try {
    const connectStart = performance.now();
    await stream.connect({ baseUrl: BASE, clientToken: token });
    const connectMs = performance.now() - connectStart;
    const started = performance.now();
    for (let offset = 0; offset < pcm.length; offset += 640) {
      await wait(
        Math.max(0, started + Math.min(offset + 640, pcm.length) / 32 - performance.now())
      );
      stream.sendAudio(pcm.subarray(offset, offset + 640));
    }
    const released = performance.now();
    const result = await stream.finalize();
    console.log(
      JSON.stringify(
        {
          endpoint: BASE,
          recordingSeconds: pcm.length / 32000,
          connectMs,
          releaseToFinalMs: performance.now() - released,
          language: result.language,
          topScore: result.languageConfidence,
          supportedScore: result.languageSupportedScore ?? null,
          analyzedSeconds: result.languageAudioSeconds ?? null,
          transcriptCharacters: result.text.length,
          hints,
        },
        null,
        2
      )
    );
  } finally {
    await stream.disconnect();
  }
}

main().catch((error) => {
  // Never print a server response or a WebSocket URL containing credentials.
  const safe = /^(Set ORUKEET_SERVICE_KEY|Expected at most|Convert WAV|Token mint returned)/;
  console.error(
    safe.test(error.message)
      ? error.message
      : "Preview failed; check the recording, service availability and credentials."
  );
  process.exitCode = 1;
});

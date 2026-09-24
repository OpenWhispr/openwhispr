"use strict";

// Operator-only: this combines backend token issuance and desktop streaming.
// The shipped desktop receives a session from OpenWhispr's authenticated backend.
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { setTimeout: sleep } = require("node:timers/promises");
const { issueSession } = require("../docs/integrations/orukeet/issue-session.cjs");
const { OrukeetStreaming } = require("../src/helpers/orukeetStreaming.js");

function readPcmWav(file) {
  const data = fs.readFileSync(file);
  if (
    data.length < 12 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Expected a WAV file");
  let format, pcm;
  for (let at = 12; at + 8 <= data.length;) {
    const id = data.toString("ascii", at, at + 4);
    const length = data.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + length > data.length) throw new Error("Truncated WAV chunk");
    if (id === "fmt " && length >= 16) {
      format = [
        data.readUInt16LE(start),
        data.readUInt16LE(start + 2),
        data.readUInt32LE(start + 4),
        data.readUInt16LE(start + 14),
      ];
    }
    if (id === "data") pcm = data.subarray(start, start + length);
    at = start + length + (length % 2);
  }
  if (JSON.stringify(format) !== "[1,1,16000,16]" || !pcm?.length || pcm.length % 2) {
    throw new Error("Expected nonempty mono 16 kHz signed PCM16 WAV");
  }
  return pcm;
}

async function main() {
  if (!process.argv[2])
    throw new Error("Usage: node scripts/benchmark-orukeet.cjs audio.wav [expected.json]");
  const pcm = readPcmWav(process.argv[2]);
  const expected = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3])).text : null;
  const runs = Number(process.env.SMOKE_RUNS || 3);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("SMOKE_RUNS must be 1-10");
  const results = [];
  for (let run = 0; run < runs; run++) {
    const client = new OrukeetStreaming();
    const sessionStart = performance.now();
    const session = await issueSession({ serviceKey: process.env.ORUKEET_SERVICE_KEY });
    const tokenIssueMs = performance.now() - sessionStart;
    let region;
    try {
      const connectStart = performance.now();
      const connected = client.connect({
        baseUrl: session.baseUrl,
        clientToken: session.clientToken,
      });
      client.ws.on("upgrade", (response) => {
        region = response.headers["x-orukeet-region"];
      });
      await connected;
      const connectionReadyMs = performance.now() - connectStart;
      const recordingStart = performance.now();
      for (let at = 0; at < pcm.length; at += 3200) {
        // Send each frame only when capture would have produced its last sample.
        // The final PCM frame is therefore queued immediately before commit.
        const target = recordingStart + Math.min(at + 3200, pcm.length) / 32;
        await sleep(Math.max(0, target - performance.now()));
        client.sendAudio(pcm.subarray(at, at + 3200));
      }
      const stop = performance.now();
      const final = await client.finalize();
      const commitToFinalMs = performance.now() - stop;
      if (expected !== null && final.text !== expected)
        throw new Error("Fixture transcript mismatch");
      results.push({
        run: run + 1,
        region,
        tokenIssueMs,
        connectionReadyMs,
        audioSeconds: pcm.length / 32000,
        commitToFinalMs,
        inferenceMs: final.inferenceMs,
        serverMs: final.serverMs,
        queueMs: final.queueMs,
        transcriptMatches: expected === null ? null : true,
        transcriptSha256: createHash("sha256").update(final.text).digest("hex"),
      });
    } finally {
      await client.disconnect();
    }
  }
  console.log(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        method:
          "Paced PCM16 using the PR adapter; commit-to-final excludes token/connection setup and recording",
        fixtureSha256: createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex"),
        results,
      },
      null,
      2
    )
  );
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { readPcmWav };

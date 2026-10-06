const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const WhisperServerManager = require("../../src/helpers/whisperServer");
const { pcm16Mono16kWav } = require("./harness/wavFixtures");

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function serveTranscript(t, onBody) {
  const { server, port } = await startServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      onBody(Buffer.concat(chunks));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "hello" }));
    });
  });
  t.after(() => server.close());
  return port;
}

function createManager(port, canConvert) {
  const manager = new WhisperServerManager();
  Object.assign(manager, {
    ready: true,
    hostname: "127.0.0.1",
    port,
    useCuda: false,
    useVulkan: false,
    canConvert,
    process: {},
    modelPath: "/tmp/model.bin",
    lastStartOptions: { useCuda: false, useVulkan: false },
  });
  return manager;
}

test("a 16 kHz mono PCM16 WAV is posted as-is, with no FFmpeg pass", async (t) => {
  let body = null;
  const manager = createManager(await serveTranscript(t, (received) => (body = received)), false);
  manager._convertToWav = async () => {
    throw new Error("FFmpeg must not run for a ready WAV");
  };
  const wav = pcm16Mono16kWav();

  const result = await manager.transcribe(wav);

  assert.equal(result.text, "hello");
  assert.ok(body.includes(wav), "the WAV bytes reach whisper-server unchanged");
});

test("any other input still goes through FFmpeg", async (t) => {
  const manager = createManager(await serveTranscript(t, () => {}), true);
  let conversions = 0;
  manager._convertToWav = async (buffer) => {
    conversions += 1;
    return buffer;
  };

  await manager.transcribe(Buffer.from("webm bytes"));

  assert.equal(conversions, 1);
});

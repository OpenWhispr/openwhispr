const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const WhisperServerManager = require("../../src/helpers/whisperServer");
const WhisperManager = require("../../src/helpers/whisper");
const { INFERENCE_DECODER_FIELDS } = WhisperServerManager;

function startCapturingServer() {
  let captured = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured = Buffer.concat(chunks).toString("latin1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "ok" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, getBody: () => captured })
    );
  });
}

function createManager(port) {
  const manager = new WhisperServerManager();
  manager.ready = true;
  manager.hostname = "127.0.0.1";
  manager.port = port;
  manager.canConvert = true;
  manager.process = {};
  manager.modelPath = "/tmp/model.bin";
  manager._convertToWav = async (buffer) => buffer;
  return manager;
}

function fieldValue(body, name) {
  const match = body.match(
    new RegExp(`Content-Disposition: form-data; name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`)
  );
  return match ? match[1] : null;
}

test("pins the measured anti-hallucination thresholds from #1458", () => {
  assert.deepEqual(INFERENCE_DECODER_FIELDS, {
    entropy_thold: "2.8",
    logprob_thold: "-1.25",
  });
});

test("sends the decoder threshold fields alongside the existing inference fields", async (t) => {
  const { server, port, getBody } = await startCapturingServer();
  t.after(() => server.close());

  const manager = createManager(port);
  const result = await manager.transcribe(Buffer.from("audio"), {
    language: "auto",
    initialPrompt: "OpenWhispr",
  });
  assert.equal(result.text, "ok");

  const body = getBody();
  for (const [name, value] of Object.entries(INFERENCE_DECODER_FIELDS)) {
    assert.equal(fieldValue(body, name), value, `expected ${name}=${value} in the request body`);
  }
  assert.equal(fieldValue(body, "language"), "auto");
  assert.equal(fieldValue(body, "prompt"), "OpenWhispr");
  assert.equal(fieldValue(body, "response_format"), "json");

  // Field order: file, language, decoder thresholds, prompt, response_format, closing boundary.
  const positions = ['name="file"', 'name="language"']
    .concat(Object.keys(INFERENCE_DECODER_FIELDS).map((name) => `name="${name}"`))
    .concat(['name="prompt"', 'name="response_format"'])
    .map((marker) => body.indexOf(marker));
  assert.ok(
    positions.every((pos, i) => pos >= 0 && (i === 0 || pos > positions[i - 1])),
    `expected ordered form fields, got positions ${positions.join(", ")}`
  );

  const boundary = body.slice(0, body.indexOf("\r\n"));
  assert.ok(body.endsWith(`${boundary}--\r\n`), "expected the closing boundary to end the body");
});

test("sends the decoder threshold fields even without an initial prompt", async (t) => {
  const { server, port, getBody } = await startCapturingServer();
  t.after(() => server.close());

  const manager = createManager(port);
  await manager.transcribe(Buffer.from("audio"), { language: "en" });

  const body = getBody();
  for (const [name, value] of Object.entries(INFERENCE_DECODER_FIELDS)) {
    assert.equal(fieldValue(body, name), value, `expected ${name}=${value} in the request body`);
  }
  assert.equal(fieldValue(body, "language"), "en");
  assert.equal(fieldValue(body, "prompt"), null);
  assert.equal(fieldValue(body, "response_format"), "json");
});

test("skipDecoderThresholds omits the raised fields so the server keeps its defaults", async (t) => {
  const { server, port, getBody } = await startCapturingServer();
  t.after(() => server.close());

  const manager = createManager(port);
  const result = await manager.transcribe(Buffer.from("audio"), {
    language: "en",
    skipDecoderThresholds: true,
  });
  assert.equal(result.text, "ok");

  const body = getBody();
  for (const name of Object.keys(INFERENCE_DECODER_FIELDS)) {
    assert.equal(fieldValue(body, name), null, `expected ${name} to be omitted`);
  }
  assert.equal(fieldValue(body, "language"), "en");
  assert.equal(fieldValue(body, "response_format"), "json");
});

test("transcribeLocalWhisper plumbs skipDecoderThresholds to the server request (meeting chunks)", async () => {
  const manager = new WhisperManager();
  const captured = [];
  manager.serverManager.isAvailable = () => true;
  manager.serverManager.start = async () => {};
  manager.serverManager.transcribe = async (_buffer, options) => {
    captured.push(options);
    return { text: "ok" };
  };
  manager.getModelPath = () => __filename;

  await manager.transcribeLocalWhisper(Buffer.from("audio"), {
    model: "base",
    skipDecoderThresholds: true,
  });
  assert.equal(captured[0].skipDecoderThresholds, true);

  // Every caller that does not opt out (dictation, note uploads) keeps the raised fields.
  await manager.transcribeLocalWhisper(Buffer.from("audio"), { model: "base" });
  assert.equal(captured[1].skipDecoderThresholds, false);
});

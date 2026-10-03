const test = require("node:test");
const assert = require("node:assert/strict");
const { transcribeWithSixtyDB } = require("../../src/helpers/sixtydbTranscription");

const AUDIO = Buffer.from("audio bytes");
const options = { audioBuffer: AUDIO, apiKey: "test-key" };

test("60db posts native multipart with a bounded signal and preserves audio bytes", async () => {
  let calls = 0;
  const result = await transcribeWithSixtyDB(
    {
      ...options,
      fileName: "quoted ' audio.wav",
      contentType: "audio/wav",
      language: "hi-IN",
      context: "Acme clinic",
    },
    async (url, init) => {
      calls++;
      assert.equal(url, "https://api.60db.ai/stt");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      assert.deepEqual(init.headers, { Authorization: "Bearer test-key" });
      // Serialize and parse native FormData, covering its boundary and file metadata.
      const request = new Request(url, init);
      assert.match(request.headers.get("content-type"), /^multipart\/form-data; boundary=/);
      const form = await request.formData();
      assert.deepEqual([...form.keys()], ["file", "language", "context"]);
      assert.equal(form.get("language"), "hi");
      assert.equal(form.get("context"), "Acme clinic");
      assert.equal(form.get("file").name, "quoted ' audio.wav");
      assert.equal(form.get("file").type, "audio/wav");
      assert.deepEqual(Buffer.from(await form.get("file").arrayBuffer()), AUDIO);
      return Response.json({ text: "नमस्ते" });
    }
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, { text: "नमस्ते", model: "sixtydb-stt" });
});

test("60db auto language and valid silence do not become fabricated text", async () => {
  for (const language of [undefined, "auto"]) {
    const result = await transcribeWithSixtyDB({ ...options, language }, async (_url, init) => {
      assert.deepEqual([...init.body.keys()], ["file"]);
      return Response.json({ text: "", language: null });
    });
    assert.equal(result.text, "");
  }
});

test("60db validates credentials, size, language and context before a request", async () => {
  const fetchImpl = () => assert.fail("invalid inputs must not send audio");
  for (const patch of [
    { apiKey: " " },
    { apiKey: null },
    { audioBuffer: Buffer.alloc(0) },
    { audioBuffer: Buffer.alloc(10 * 1024 * 1024 + 1) },
    { audioBuffer: "audio" },
    { language: "invalid" },
    { context: {} },
  ]) {
    await assert.rejects(transcribeWithSixtyDB({ ...options, ...patch }, fetchImpl));
  }
});

test("60db accepts the size boundary and ArrayBuffer IPC payloads", async () => {
  await transcribeWithSixtyDB(
    { ...options, audioBuffer: new ArrayBuffer(10 * 1024 * 1024) },
    async () => Response.json({ text: "ok" })
  );
});

test("60db HTTP failures are classified, sanitized and never retried", async () => {
  for (const [status, code] of [
    [401, "INVALID_KEY"],
    [403, "INVALID_KEY"],
    [402, undefined],
    [429, "PROVIDER_RATE_LIMITED"],
    [503, "SERVER_ERROR"],
    [302, undefined],
  ]) {
    let calls = 0;
    await assert.rejects(
      transcribeWithSixtyDB(options, async () => {
        calls++;
        return new Response("test-key private transcript", { status });
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.ok(!error.message.includes("test-key"));
        assert.ok(!error.message.includes("private transcript"));
        return true;
      }
    );
    assert.equal(calls, 1);
  }
});

test("60db rejects malformed responses and sanitizes transport failures", async () => {
  for (const data of [{}, { text: null }, { text: 42 }, { success: false, text: "partial" }]) {
    await assert.rejects(
      transcribeWithSixtyDB(options, async () => Response.json(data)),
      /Invalid 60db/
    );
  }
  await assert.rejects(
    transcribeWithSixtyDB(options, async () => new Response("private not JSON")),
    /Invalid 60db/
  );
  await assert.rejects(
    transcribeWithSixtyDB(options, async () => {
      throw new Error("test-key private network error");
    }),
    (error) => {
      assert.equal(error.message, "60db transcription request failed or timed out");
      return true;
    }
  );
});

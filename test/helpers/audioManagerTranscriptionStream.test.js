const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const encode = (text) => new TextEncoder().encode(text);
const event = (type, fields) => `data: ${JSON.stringify({ type, ...fields })}\n\n`;

function responseFromChunks(chunks) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}

test("transcription SSE preserves text across response chunk boundaries", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-transcription-stream-test-",
    settingsKey: "__transcriptionStreamSettings",
    settings: {
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionModel: "gpt-4o-mini-transcribe",
      allowLocalFallback: false,
    },
  });
  const manager = createManager();
  const text = 'Hello 世界 🙂 "quoted"\nsecond line';
  const wire = encode(event("transcript.text.done", { text }));

  await t.test("every two-chunk split gives the same final text", async () => {
    assert.equal(await manager.readTranscriptionStream(responseFromChunks([wire])), text);
    for (let split = 1; split < wire.length; split += 1) {
      const response = responseFromChunks([wire.subarray(0, split), wire.subarray(split)]);
      assert.equal(await manager.readTranscriptionStream(response), text, `split at byte ${split}`);
    }
  });

  await t.test("byte-sized chunks preserve deltas, segments, UTF-8 and DONE", async () => {
    const bytes = encode(
      event("transcript.text.delta", { delta: "Hello " }) +
        event("transcript.text.segment", { text: "世界 🙂" }) +
        "data: [DONE]\n\n"
    );
    const chunks = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
    assert.equal(
      await manager.readTranscriptionStream(responseFromChunks(chunks)),
      "Hello 世界 🙂"
    );
  });

  for (const [name, input, expected] of [
    ["empty stream", "", ""],
    [
      "a complete final data line still works without a trailing newline",
      'data: {"type":"transcript.text.done","text":"final at EOF"}',
      "final at EOF",
    ],
    [
      "coalesced events prefer the final transcript",
      event("transcript.text.delta", { delta: "draft" }) +
        event("transcript.text.done", { text: "final" }) +
        "data: [DONE]\n\n",
      "final",
    ],
    [
      "deltas and segments survive EOF without a final event",
      event("transcript.text.delta", { delta: "Hello " }) +
        event("transcript.text.segment", { text: "world" }),
      "Hello world",
    ],
    [
      "compact data fields and CRLF keep their existing behavior",
      'data:{"type":"transcript.text.done","text":"compact"}\r\n\r\n',
      "compact",
    ],
    [
      "an unfinished tail cannot erase a completed event",
      event("transcript.text.delta", { delta: "complete" }) +
        'data: {"type":"transcript.text.done","text":"unfinished',
      "complete",
    ],
  ]) {
    await t.test(name, async () => {
      assert.equal(
        await manager.readTranscriptionStream(responseFromChunks([encode(input)])),
        expected
      );
    });
  }

  await t.test(
    "completed non-data and malformed lines cannot contaminate a partial tail",
    async () => {
      const first = encode(': keepalive\nevent: transcript\nid: 1\ndata: invalid\ndata: {"ty');
      const second = encode('pe":"transcript.text.done","text":"intact"}\n\n');
      assert.equal(
        await manager.readTranscriptionStream(responseFromChunks([first, second])),
        "intact"
      );
    }
  );

  await t.test(
    "reader failure propagates and the next call starts with a fresh buffer",
    async () => {
      const error = new Error("stream disconnected");
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(error);
          },
        })
      );
      await assert.rejects(manager.readTranscriptionStream(response), (actual) => actual === error);
      assert.equal(await manager.readTranscriptionStream(responseFromChunks([wire])), text);
    }
  );

  await t.test("OpenAI dictation accepts the fragmented response on repeated calls", async (t) => {
    const apiManager = createManager({
      getEffectiveSttLanguage: () => "auto",
      getTranscriptionModel: () => "gpt-4o-mini-transcribe",
      getAPIKey: async () => "test-key",
      getTranscriptionEndpoint: () => "https://api.openai.com/v1/audio/transcriptions",
      getWhisperPrompt: () => null,
      isDictionaryEcho: () => false,
      processTranscription: async (value) => value,
      isReasoningAvailable: async () => false,
    });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      calls += 1;
      assert.equal(init.body.get("stream"), "true");
      return responseFromChunks([wire.subarray(0, 3), wire.subarray(3, 60), wire.subarray(60)]);
    });
    const audio = new Blob(["recording"], { type: "audio/webm" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await apiManager.processWithOpenAIAPI(audio);
      assert.equal(result.success, true);
      assert.equal(result.text, text);
      assert.equal(result.rawText, text);
      assert.equal(result.source, "openai");
      assert.equal(apiManager._activeTranscriptionAbortController, null);
    }
    assert.equal(calls, 2);
  });
});

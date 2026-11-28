const test = require("node:test");
const assert = require("node:assert/strict");
const { synthesizeGnaniPreview } = require("../../src/helpers/gnaniVoicePreview");

const request = (text, fetchImpl, apiKey = "test-key") =>
  synthesizeGnaniPreview({ text, apiKey, fetchImpl, signal: new AbortController().signal });

test("a Gnani voice preview sends the entered text to Timbre and returns its audio", async () => {
  const result = await request(" नमस्ते ", async (url, options) => {
    assert.equal(url, "https://api.vachana.ai/api/v1/tts/inference");
    assert.equal(options.headers["X-API-Key-ID"], "test-key");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), {
      text: "नमस्ते",
      model: "timbre-v3.0",
      voice: "Shivani",
      language: "auto",
      audio_config: { container: "mp3", sample_rate: 24000 },
    });
    return new Response(Uint8Array.of(1, 2, 3));
  });
  assert.deepEqual(new Uint8Array(result.audio), Uint8Array.of(1, 2, 3));
});

test("invalid voice previews never use the key and failed responses never become audio", async () => {
  for (const text of ["  ", "a".repeat(301)]) {
    await assert.rejects(
      request(text, () => assert.fail("unexpected request")),
      /300 characters/
    );
  }
  await assert.rejects(request("hello", () => assert.fail("unexpected request"), ""));
  await assert.rejects(
    request("hello", () => new Response(null, { status: 403 })),
    {
      status: 403,
    }
  );
  await assert.rejects(
    request("hello", () => new Response(null)),
    /empty audio/
  );
});

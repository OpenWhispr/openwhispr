const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { transcribeWithFish } = require("../../src/helpers/fishTranscription");

const request = { audioBuffer: Buffer.from("audio"), apiKey: "test-credential" };
const success = (text) => async () => ({ ok: true, json: async () => ({ text }) });

function replaceConverter(t, convertBufferToWav) {
  const originalLoad = Module._load;
  t.mock.method(Module, "_load", function (id, parent, isMain) {
    if (id === "./ffmpegUtils" && /[/\\]fishTranscription\.js$/.test(parent.filename)) {
      return { convertBufferToWav };
    }
    return originalLoad.call(this, id, parent, isMain);
  });
}

test("uses Fish's multipart contract rather than the OpenAI transcription format", async () => {
  let sent;
  await transcribeWithFish(
    {
      ...request,
      apiKey: "  test-credential  ",
      contentType: "audio/webm",
      fileName: "dictation.webm",
      language: "PT-BR",
    },
    async (url, init) => {
      sent = { url, ...init };
      return { ok: true, json: async () => ({ text: "Olá." }) };
    }
  );
  assert.equal(sent.url, "https://api.fish.audio/v1/asr");
  assert.equal(sent.method, "POST");
  assert.deepEqual(sent.headers, {
    Authorization: "Bearer test-credential",
    model: "transcribe-1-pro",
  });
  assert.deepEqual([...sent.body.keys()].sort(), [
    "audio",
    "diarize",
    "ignore_timestamps",
    "language",
    "tag_audio_events",
  ]);
  const audio = sent.body.get("audio");
  assert.equal(audio.name, "dictation.webm");
  assert.equal(audio.type, "audio/webm");
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), request.audioBuffer);
  assert.equal(sent.body.get("language"), "pt");
  assert.equal(sent.body.get("ignore_timestamps"), "true");
  assert.equal(sent.body.get("diarize"), "false");
  assert.equal(sent.body.get("tag_audio_events"), "false");
});

test("missing and stale model selections choose Pro instead of Fish's silent legacy fallback", async () => {
  for (const model of [undefined, "", "  ", "whisper-1", "transcribe-2", "transcribe-1-pro"]) {
    let sentModel;
    const result = await transcribeWithFish({ ...request, model }, async (_url, init) => {
      sentModel = init.headers.model;
      return { ok: true, json: async () => ({ text: "Hello." }) };
    });
    assert.equal(sentModel, "transcribe-1-pro", String(model));
    assert.equal(result.model, "transcribe-1-pro", String(model));
  }
});

test("legacy model selection survives trimming and omits Pro-only form fields", async () => {
  for (const model of ["transcribe-1", " transcribe-1 "]) {
    let sent;
    const result = await transcribeWithFish({ ...request, model }, async (_url, init) => {
      sent = init;
      return { ok: true, json: async () => ({ text: "Hello." }) };
    });
    assert.equal(result.model, "transcribe-1");
    assert.equal(sent.headers.model, "transcribe-1");
    assert.deepEqual([...sent.body.keys()].sort(), ["audio", "ignore_timestamps"]);
  }
});

test("automatic language detection sends no language hint", async () => {
  for (const language of [undefined, "", "auto"]) {
    await transcribeWithFish({ ...request, language }, async (_url, init) => {
      assert.equal(init.body.has("language"), false);
      return { ok: true, json: async () => ({ text: "" }) };
    });
  }
});

test("legacy unsupported containers become WAV uploads, not mislabeled original bytes", async (t) => {
  const wav = Buffer.from("converted WAV bytes");
  replaceConverter(t, async () => wav);
  for (const contentType of ["audio/webm;codecs=opus", "video/x-matroska", "video/quicktime"]) {
    await transcribeWithFish(
      { ...request, model: "transcribe-1", contentType, fileName: "recording.container" },
      async (_url, init) => {
        const audio = init.body.get("audio");
        assert.equal(audio.name, "audio.wav", contentType);
        assert.equal(audio.type, "audio/wav", contentType);
        assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav, contentType);
        return { ok: true, json: async () => ({ text: "Hello." }) };
      }
    );
  }
});

test("the upload cap applies after legacy WAV conversion expands the audio", async (t) => {
  replaceConverter(t, async () => Buffer.alloc(25 * 1024 * 1024 + 1));
  await assert.rejects(
    transcribeWithFish({ ...request, model: "transcribe-1", contentType: "audio/webm" }, async () =>
      assert.fail("must not send oversized WAV")
    ),
    /25 MB/
  );
});

test("plain dictation removes Fish speaker tokens but preserves spoken text", async () => {
  const result = await transcribeWithFish(
    request,
    success("<|speaker:0|> Hello. <|speaker:12|> How are you? <|speaker:0|> Fine.")
  );
  assert.equal(result.text, "Hello. How are you? Fine.");
});

test("speaker cleanup preserves punctuation, Unicode, and ordinary speaker labels", async () => {
  const result = await transcribeWithFish(
    request,
    success("<|speaker:0|> Bonjour, 世界!\nSpeaker 1: «oui». <|speaker:12|> Ça va?")
  );
  assert.equal(result.text, "Bonjour, 世界!\nSpeaker 1: «oui». Ça va?");
  assert.equal((await transcribeWithFish(request, success(" <|speaker:0|> \n"))).text, "");
});

test("silence is an empty transcript, malformed success is an error", async () => {
  assert.equal((await transcribeWithFish(request, success(""))).text, "");
  for (const text of [undefined, null, 42, {}]) {
    await assert.rejects(transcribeWithFish(request, success(text)), /invalid transcription/);
  }
});

test("missing credentials and oversized audio fail before sending audio", async () => {
  const noNetwork = async () => assert.fail("must not send audio");
  for (const apiKey of [undefined, "", "  "]) {
    await assert.rejects(transcribeWithFish({ ...request, apiKey }, noNetwork), {
      code: "API_KEY_MISSING",
    });
  }
  await assert.rejects(
    transcribeWithFish({ ...request, audioBuffer: Buffer.alloc(25 * 1024 * 1024 + 1) }, noNetwork),
    /25 MB/
  );
});

test("HTTP failures expose actionable house error codes, never response credentials", async () => {
  for (const [status, code] of [
    [401, "INVALID_KEY"],
    [403, "INVALID_KEY"],
    [402, undefined],
    [429, "PROVIDER_RATE_LIMITED"],
    [503, "SERVER_ERROR"],
    [413, undefined],
  ]) {
    await assert.rejects(
      transcribeWithFish(request, async () => ({
        ok: false,
        status,
        text: async () => `untrusted body ${request.apiKey}`,
      })),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.message.includes(request.apiKey), false);
        if (status === 402) assert.match(error.message, /credit/);
        if (status === 429) {
          assert.equal(
            error.messageKey,
            "hooks.audioRecording.errorDescriptions.providerRateLimited"
          );
        }
        return true;
      }
    );
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");

const {
  GeminiLiveStreaming,
  buildGeminiLiveUrl,
} = require("../../src/helpers/geminiLiveStreaming");

const FRAME = Buffer.alloc(1600); // one 50ms worklet frame at 16kHz s16le

// Loopback Live server. `script(socket, message)` reacts to each client
// message; the default answers `setup` with setupComplete, like the real one.
async function withServer(run, script) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const received = [];
  const urls = [];
  const reply = script || ((socket) => socket.send(JSON.stringify({ setupComplete: {} })));

  server.on("connection", (socket, request) => {
    urls.push(request.url);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);
      reply(socket, message, urls.length);
    });
  });

  const streaming = new GeminiLiveStreaming();
  streaming.buildWebSocketUrl = ({ token }) =>
    `ws://127.0.0.1:${server.address().port}/?t=${token}`;

  try {
    await run({ streaming, received, urls });
  } finally {
    streaming.cleanup();
    await new Promise((resolve) => server.close(resolve));
  }
}

const audioFrames = (received) => received.filter((message) => message.realtimeInput?.audio);

test("url: the two Live methods are auth-disjoint and pinned per mode", () => {
  assert.equal(
    buildGeminiLiveUrl({ mode: "byok", token: "AI-KEY" }),
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=AI-KEY"
  );
  assert.equal(
    buildGeminiLiveUrl({ mode: "openwhispr", token: "auth_tokens/abc" }),
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens/abc"
  );
});

test("setup: the custom dictionary always ships; a language only when chosen", () => {
  const streaming = new GeminiLiveStreaming();

  assert.deepEqual(streaming.buildSetupMessage({ keyterms: ["OpenWhispr", " ", ""] }), {
    setup: {
      model: "models/gemini-3.5-transcribe-live",
      generationConfig: { responseModalities: ["TEXT"] },
      inputAudioTranscription: { customVocabulary: ["OpenWhispr"] },
    },
  });

  assert.deepEqual(
    streaming.buildSetupMessage({ model: "gemini-next", language: "en", keyterms: [] }),
    {
      setup: {
        model: "models/gemini-next",
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: { languageCodes: ["en"] },
      },
    }
  );

  const many = streaming.buildSetupMessage({
    keyterms: Array.from({ length: 150 }, (_, i) => `term-${i}`),
  });
  assert.equal(many.setup.inputAudioTranscription.customVocabulary.length, 100);
});

test("connect resolves on setupComplete, not on socket open", async () => {
  await withServer(
    async ({ streaming, received }) => {
      streaming.beginConnecting();
      // Frames from the token-fetch / handshake window are buffered, not sent.
      assert.equal(streaming.sendAudio(FRAME), false);

      const connected = streaming.connect({ token: "t", mode: "byok", keyterms: ["OpenWhispr"] });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(streaming.isConnected, false, "open alone must not mark the session ready");
      assert.equal(streaming.sendAudio(FRAME), false);

      await connected;
      assert.equal(streaming.isConnected, true);
      assert.deepEqual(received[0].setup.inputAudioTranscription, {
        customVocabulary: ["OpenWhispr"],
      });
    },
    (socket, message) => {
      if (!message.setup) return;
      setTimeout(() => socket.send(JSON.stringify({ setupComplete: {} })), 60);
    }
  );
});

test("connect rejects when the socket closes before setupComplete", async () => {
  await withServer(
    async ({ streaming }) => {
      await assert.rejects(streaming.connect({ token: "t", mode: "byok" }), /closed.*1008/i);
      assert.equal(streaming.isConnected, false);
    },
    (socket) => socket.close(1008, "Requested entity was not found.")
  );
});

test("audio: buffered frames flush in order, then stream as base64 PCM frames", async () => {
  await withServer(async ({ streaming, received }) => {
    streaming.beginConnecting();
    const first = Buffer.alloc(1600, 1);
    const second = Buffer.alloc(1600, 2);
    streaming.sendAudio(first);
    streaming.sendAudio(second);

    await streaming.connect({ token: "t", mode: "byok" });
    const live = Buffer.alloc(1600, 3);
    assert.equal(streaming.sendAudio(live), true);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const frames = audioFrames(received);
    assert.deepEqual(
      frames.map((frame) => frame.realtimeInput.audio.mimeType),
      ["audio/pcm;rate=16000", "audio/pcm;rate=16000", "audio/pcm;rate=16000"]
    );
    assert.deepEqual(
      frames.map((frame) => Buffer.from(frame.realtimeInput.audio.data, "base64")[0]),
      [1, 2, 3]
    );
    assert.equal(streaming.audioBytesSent, 4800);
  });
});

test("audio: cold-start buffering is bounded at three seconds of PCM", async () => {
  const streaming = new GeminiLiveStreaming();
  streaming.beginConnecting();
  for (let i = 0; i < 100; i++) streaming.sendAudio(Buffer.alloc(1600));
  assert.equal(streaming.coldStartBufferSize, 96000);
});

test("characterization: the worklet's flush sentinel is never sent as audio", async () => {
  await withServer(async ({ streaming, received }) => {
    await streaming.connect({ token: "t", mode: "byok" });
    assert.equal(streaming.sendAudio(Buffer.from("flushed")), false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(audioFrames(received).length, 0);
    assert.equal(streaming.audioBytesSent, 0);
  });
});

test("transcripts: partials replace, finals accumulate", async () => {
  await withServer(
    async ({ streaming }) => {
      const partials = [];
      const finals = [];
      streaming.onPartialTranscript = (text) => partials.push(text);
      streaming.onFinalTranscript = (text) => finals.push(text);

      await streaming.connect({ token: "t", mode: "byok" });
      streaming.sendAudio(FRAME);
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Partials are revised, not appended to — casing included.
      assert.deepEqual(partials, ["The quick brown", "the quick brown fox"]);
      assert.deepEqual(finals, [
        "The quick brown fox.",
        "The quick brown fox. OpenWhispr transcription test.",
      ]);
      assert.equal(
        streaming.getFullTranscript(),
        "The quick brown fox. OpenWhispr transcription test."
      );
    },
    (socket, message) => {
      if (message.setup) {
        socket.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (!message.realtimeInput?.audio) return;
      for (const text of ["The quick brown", "the quick brown fox"]) {
        socket.send(JSON.stringify({ serverContent: { interimInputTranscription: { text } } }));
      }
      socket.send(
        JSON.stringify({ serverContent: { inputTranscription: { text: "The quick brown fox." } } })
      );
      socket.send(
        JSON.stringify({
          serverContent: { inputTranscription: { text: "OpenWhispr transcription test." } },
        })
      );
    }
  );
});

test("disconnect sends audioStreamEnd once and waits for the end of the turn", async () => {
  await withServer(
    async ({ streaming, received }) => {
      await streaming.connect({ token: "t", mode: "byok" });
      streaming.sendAudio(FRAME);

      // The stop sequence calls finalize(), waits for the text to settle, then
      // stops — so disconnect must not send audioStreamEnd a second time.
      assert.equal(streaming.finalize(), true);
      assert.equal(streaming.finalize(), false, "audioStreamEnd must not be sent twice");
      await new Promise((resolve) => setTimeout(resolve, 40));

      const result = await streaming.disconnect(true);
      assert.equal(result.text, "The quick brown fox.");
      assert.equal(received.filter((m) => m.realtimeInput?.audioStreamEnd).length, 1);
      // The transcript is handed over, not kept for the next session.
      assert.equal(streaming.getFullTranscript(), "");
    },
    (socket, message) => {
      if (message.setup) {
        socket.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (!message.realtimeInput?.audioStreamEnd) return;
      socket.send(
        JSON.stringify({ serverContent: { inputTranscription: { text: "The quick brown fox." } } })
      );
      socket.send(JSON.stringify({ serverContent: { generationComplete: true } }));
    }
  );
});

test("disconnect returns the accumulated text when the turn never ends cleanly", async () => {
  await withServer(
    async ({ streaming }) => {
      await streaming.connect({ token: "t", mode: "byok" });
      streaming.sendAudio(FRAME);
      await new Promise((resolve) => setTimeout(resolve, 30));

      // No generationComplete: the socket dies instead, which must release the
      // finalization wait rather than burn its whole budget.
      assert.deepEqual(await streaming.disconnect(true), { text: "partial turn" });
    },
    (socket, message) => {
      if (message.setup) {
        socket.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (message.realtimeInput?.audio) {
        socket.send(
          JSON.stringify({ serverContent: { inputTranscription: { text: "partial turn" } } })
        );
      }
      if (message.realtimeInput?.audioStreamEnd) socket.close(1000, "");
    }
  );
});

test("errors: a bad key close frame becomes the coded, fixable error", async () => {
  await withServer(
    async ({ streaming }) => {
      await assert.rejects(
        streaming.connect({ token: "nope", mode: "byok" }),
        (err) => err.code === "INVALID_KEY" && /Check your key in Settings/.test(err.message)
      );
    },
    (socket) => socket.close(1007, "API key not valid. Please pass a valid API key.")
  );
});

test("errors: a spent managed token is re-minted once and the session survives", async () => {
  await withServer(
    async ({ streaming, urls }) => {
      await streaming.connect({
        token: "auth_tokens/spent",
        mode: "openwhispr",
        refreshToken: async () => "auth_tokens/fresh",
      });
      assert.equal(streaming.isConnected, true);
      assert.deepEqual(urls, ["/?t=auth_tokens/spent", "/?t=auth_tokens/fresh"]);
    },
    (socket, _message, connectionCount) => {
      if (connectionCount === 1) {
        socket.close(1011, "Token has been used too many times");
        return;
      }
      socket.send(JSON.stringify({ setupComplete: {} }));
    }
  );
});

test("errors: byok never retries a 1011 close (there is no token to re-mint)", async () => {
  await withServer(
    async ({ streaming, urls }) => {
      await assert.rejects(
        streaming.connect({
          token: "key",
          mode: "byok",
          refreshToken: async () => "unused",
        }),
        (err) => err.code === "AUTH_EXPIRED"
      );
      assert.equal(urls.length, 1);
    },
    (socket) => socket.close(1011, "Token has expired")
  );
});

test("an unexpected close hands the transcript over and reports the loss once", async () => {
  await withServer(
    async ({ streaming }) => {
      const errors = [];
      const sessionEnds = [];
      streaming.onError = (err) => errors.push(err.message);
      streaming.onSessionEnd = (data) => sessionEnds.push(data);

      await streaming.connect({ token: "t", mode: "byok" });
      streaming.sendAudio(FRAME);
      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.deepEqual(sessionEnds, [{ text: "half a sentence" }]);
      assert.equal(errors.length, 1);
      assert.equal(streaming.isConnected, false);
    },
    (socket, message) => {
      if (message.setup) {
        socket.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (!message.realtimeInput?.audio) return;
      socket.send(
        JSON.stringify({ serverContent: { inputTranscription: { text: "half a sentence" } } })
      );
      setTimeout(() => socket.close(1011, "Token has expired"), 10);
    }
  );
});

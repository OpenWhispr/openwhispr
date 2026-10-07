const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { WebSocketServer } = require("ws");

const CortiStreaming = require("../../src/helpers/cortiStreaming");
const { audioRecorder } = require("./harness/audioRecorder");

const OPTIONS = { token: "test-token", environment: "us", tenant: "base" };
const FRAME_BYTES = 1600; // one 50 ms worklet frame at 16 kHz

// Loopback audio bridge. It accepts the config a beat after it arrives, so audio
// sent ahead of the ack shows up in `audioBeforeAccept`, and it answers flush.
async function withCortiServer(run) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const sessions = [];
  server.on("connection", (socket) => {
    const session = { audio: audioRecorder(), audioBeforeAccept: 0, accepted: false };
    sessions.push(session);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!session.accepted) session.audioBeforeAccept++;
        session.audio.record(data);
        return;
      }
      const message = JSON.parse(data.toString());
      if (message.type === "config") {
        setTimeout(() => {
          session.accepted = true;
          socket.send(JSON.stringify({ type: "CONFIG_ACCEPTED", sessionId: "test-session" }));
        }, 50);
      } else if (message.type === "flush") {
        socket.send(JSON.stringify({ type: "flushed" }));
      }
    });
  });

  try {
    await run(`ws://127.0.0.1:${server.address().port}`, sessions);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("audio sent before the config is accepted reaches the server after it, in order", async () => {
  await withCortiServer(async (url, sessions) => {
    const streaming = new CortiStreaming();
    streaming.buildWebSocketUrl = () => url;
    const frames = [1, 2, 3, 4, 5, 6].map((value) => Buffer.alloc(FRAME_BYTES, value));

    try {
      const connected = streaming.connect(OPTIONS);
      // The opening words of a cold start: offered while the socket connects,
      // then while it is open but the config is not yet accepted.
      for (const frame of frames.slice(0, 2)) streaming.sendAudio(frame);
      await once(streaming.ws, "open");
      for (const frame of frames.slice(2, 4)) streaming.sendAudio(frame);
      await connected;
      for (const frame of frames.slice(4)) streaming.sendAudio(frame);

      assert.deepEqual(await sessions[0].audio.received(6 * FRAME_BYTES), Buffer.concat(frames));
      assert.equal(sessions[0].audioBeforeAccept, 0, "Corti rejects audio sent before its ack");
    } finally {
      streaming.cleanup();
    }
  });
});

test("a client with no start in flight takes no audio", () => {
  const streaming = new CortiStreaming();
  assert.equal(streaming.sendAudio(Buffer.alloc(FRAME_BYTES)), false, "an idle client held audio");

  streaming.beginConnecting();
  streaming.cleanup(); // what a closed or failed socket runs
  assert.equal(streaming.sendAudio(Buffer.alloc(FRAME_BYTES)), false, "an ended start held audio");
});

test("a late CONFIG_ACCEPTED with no socket open does not throw", () => {
  // A stale socket's listener can deliver it (one whose start already timed
  // out) while a new start holds audio and has no socket of its own yet.
  const streaming = new CortiStreaming();
  streaming.beginConnecting();
  streaming.sendAudio(Buffer.alloc(FRAME_BYTES));

  assert.doesNotThrow(() =>
    streaming.handleMessage(Buffer.from(JSON.stringify({ type: "CONFIG_ACCEPTED" })))
  );
});

test("audio held before the config is accepted is capped at three seconds", () => {
  const streaming = new CortiStreaming();
  streaming.beginConnecting();

  // Five seconds of 50 ms frames at 16 kHz: the first three seconds are 60 frames.
  const held = Array.from({ length: 100 }, () => streaming.sendAudio(Buffer.alloc(FRAME_BYTES)));

  assert.deepEqual(held, [...Array(60).fill(true), ...Array(40).fill(false)]);
});

test("events from a socket this start replaced leave the start alone", () => {
  const streaming = new CortiStreaming();
  const staleSocket = new EventEmitter();
  streaming.attachSocketHandlers(staleSocket);
  streaming.beginConnecting();
  streaming.sendAudio(Buffer.alloc(FRAME_BYTES));

  staleSocket.emit("message", Buffer.from(JSON.stringify({ type: "CONFIG_ACCEPTED" })));
  staleSocket.emit("close", 1000, Buffer.alloc(0));

  assert.equal(streaming.configAccepted, false, "a stale ack marked the new start accepted");
  assert.equal(streaming.preConfigBufferSize, FRAME_BYTES, "a stale close wiped the held audio");
  assert.equal(streaming.sendAudio(Buffer.alloc(FRAME_BYTES)), true, "the start stopped holding");
});

test("a stop before the socket exists drops the audio the start was holding", async () => {
  const streaming = new CortiStreaming();
  streaming.beginConnecting();
  streaming.sendAudio(Buffer.alloc(FRAME_BYTES));

  await streaming.disconnect(true);

  assert.equal(
    streaming.sendAudio(Buffer.alloc(FRAME_BYTES)),
    false,
    "a stopped client held audio"
  );
  assert.equal(streaming.preConfigBufferSize, 0);
});

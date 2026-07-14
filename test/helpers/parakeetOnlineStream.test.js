const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { WebSocketServer } = require("ws");

const ParakeetWsServer = require("../../src/helpers/parakeetWsServer");
const { pcm16ToFloat32 } = require("../../src/utils/audioUtils");

// Mock sherpa online WS protocol: float32 binary frames in, JSON results out, "Done"/"Done!" handshake.
async function startMockOnlineServer({ onBinary, finalSegment = 0 }) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");

  wss.on("connection", (socket) => {
    let binaryFrames = 0;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        binaryFrames += 1;
        onBinary?.(socket, data, binaryFrames);
        return;
      }
      if (data.toString() === "Done") {
        socket.send(
          JSON.stringify({
            text: `final after ${binaryFrames} frames`,
            segment: finalSegment,
            is_final: true,
          })
        );
        socket.send("Done!");
      }
    });
  });

  return {
    port: wss.address().port,
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

function onlineWsServerAt(port) {
  const server = new ParakeetWsServer();
  server.ready = true;
  server.process = { pid: 1 };
  server.port = port;
  server.modelRuntime = "online";
  return server;
}

test("online stream emits live updates and finish resolves with the final text", async () => {
  const mock = await startMockOnlineServer({
    onBinary: (socket, _data, frameCount) => {
      socket.send(
        JSON.stringify({ text: `partial ${frameCount}`, segment: 0, is_final: false })
      );
    },
  });

  try {
    const updates = [];
    const stream = onlineWsServerAt(mock.port).createOnlineStream({
      onUpdate: (text) => updates.push(text),
    });

    // Chunks sent before the socket opens must be queued, not dropped.
    stream.sendPcm16(Buffer.alloc(3200));
    stream.sendFloat32(pcm16ToFloat32(Buffer.alloc(3200)));

    const { text } = await stream.finish();

    assert.equal(text, "final after 2 frames");
    assert.ok(updates.includes("partial 1"));
    assert.ok(updates.includes("partial 2"));
  } finally {
    await mock.close();
  }
});

test("finalized segments accumulate across endpoints in live updates", async () => {
  let segment = 0;
  const mock = await startMockOnlineServer({
    finalSegment: 2,
    onBinary: (socket, _data, frameCount) => {
      // Simulate endpointing: every frame finalizes a segment.
      socket.send(
        JSON.stringify({ text: `segment ${frameCount}`, segment: segment++, is_final: true })
      );
    },
  });

  try {
    let lastUpdate = "";
    const stream = onlineWsServerAt(mock.port).createOnlineStream({
      onUpdate: (text) => {
        lastUpdate = text;
      },
    });

    stream.sendPcm16(Buffer.alloc(3200));
    stream.sendPcm16(Buffer.alloc(3200));

    const { text } = await stream.finish();

    assert.equal(text, "segment 1 segment 2 final after 2 frames");
    assert.equal(lastUpdate, text);
  } finally {
    await mock.close();
  }
});

test("createOnlineStream rejects offline-runtime sessions and dead servers", () => {
  const offline = onlineWsServerAt(1);
  offline.modelRuntime = "offline";
  assert.throws(() => offline.createOnlineStream(), /online-runtime/);

  const dead = onlineWsServerAt(1);
  dead.ready = false;
  assert.throws(() => dead.createOnlineStream(), /not running/);
});

test("abort closes the stream without waiting for the server", async () => {
  const mock = await startMockOnlineServer({});
  try {
    const stream = onlineWsServerAt(mock.port).createOnlineStream({});
    stream.sendPcm16(Buffer.alloc(3200));
    stream.abort();
    const { text } = await stream.finish();
    assert.equal(text, "");
  } finally {
    await mock.close();
  }
});

test("pcm16ToFloat32 converts int16 samples to normalized float32", () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(16384, 2);
  pcm.writeInt16LE(-16384, 4);
  pcm.writeInt16LE(-32768, 6);

  const floats = pcm16ToFloat32(pcm);

  assert.ok(floats instanceof Float32Array);
  assert.deepEqual(Array.from(floats), [0, 0.5, -0.5, -1]);
});

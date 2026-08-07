const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/preparedMicCapture.js");

const fakeStream = (onStop) => ({
  getTracks: () => [{ stop: () => onStop?.() }],
});

test("take reuses the in-flight prepared capture", async () => {
  const { PreparedMicCapture } = await load();
  let resolveAcquire;
  let acquisitions = 0;
  const capture = new PreparedMicCapture();
  const stream = fakeStream();

  capture.prepare(
    () =>
      new Promise((resolve) => {
        acquisitions += 1;
        resolveAcquire = resolve;
      })
  );
  const taken = capture.take();
  await Promise.resolve();
  resolveAcquire({ stream, constraints: { audio: true }, chunks: [] });

  assert.equal((await taken).stream, stream);
  assert.equal(acquisitions, 1);
});

test("cancel disposes a prepared value (stream and recorder stopped)", async () => {
  const { PreparedMicCapture } = await load();
  let streamStops = 0;
  let recorderStops = 0;
  const capture = new PreparedMicCapture();

  await capture.prepare(async () => ({
    stream: fakeStream(() => (streamStops += 1)),
    recorder: { state: "recording", stop: () => (recorderStops += 1) },
    chunks: [],
    constraints: { audio: true },
  }));
  capture.cancel();

  assert.equal(streamStops, 1);
  assert.equal(recorderStops, 1);
  assert.equal(await capture.take(), null);
});

test("cancel during acquisition disposes the value when it arrives", async () => {
  const { PreparedMicCapture } = await load();
  let resolveAcquire;
  let streamStops = 0;
  const capture = new PreparedMicCapture();

  const preparation = capture.prepare(
    () =>
      new Promise((resolve) => {
        resolveAcquire = resolve;
      })
  );
  await Promise.resolve();
  capture.cancel();
  resolveAcquire({ stream: fakeStream(() => (streamStops += 1)), chunks: [] });

  assert.equal(await preparation, null);
  assert.equal(streamStops, 1);
  assert.equal(await capture.take(), null);
});

test("take falls back cleanly when preparation fails", async () => {
  const { PreparedMicCapture } = await load();
  const capture = new PreparedMicCapture();
  const preparation = capture.prepare(async () => {
    throw new Error("device busy");
  });

  await assert.rejects(preparation, /device busy/);
  assert.equal(await capture.take(), null);
});

test("expires an untaken prepared value after maxAgeMs", async () => {
  const { PreparedMicCapture } = await load();
  const disposed = [];
  let expire;
  const capture = new PreparedMicCapture({
    dispose: (prepared) => disposed.push(prepared),
    maxAgeMs: 1000,
    setTimer: (fn) => {
      expire = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  const value = { stream: fakeStream(), chunks: [] };
  await capture.prepare(async () => value);
  expire();

  assert.deepEqual(disposed, [value]);
  assert.equal(await capture.take(), null);
});

test("take before expiry cancels the expiry timer", async () => {
  const { PreparedMicCapture } = await load();
  const cleared = [];
  const capture = new PreparedMicCapture({
    dispose: () => {},
    maxAgeMs: 1000,
    setTimer: () => 42,
    clearTimer: (id) => cleared.push(id),
  });
  await capture.prepare(async () => ({ stream: fakeStream(), chunks: [] }));

  assert.equal((await capture.take()).stream.getTracks().length, 1);
  assert.deepEqual(cleared, [42]);
});

test("a prepared value that expired is not handed to a later prepare", async () => {
  const { PreparedMicCapture } = await load();
  let expire;
  const capture = new PreparedMicCapture({
    dispose: () => {},
    maxAgeMs: 1000,
    setTimer: (fn) => {
      expire = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  await capture.prepare(async () => ({ stream: fakeStream(), id: "first", chunks: [] }));
  expire();
  const second = await capture.prepare(async () => ({
    stream: fakeStream(),
    id: "second",
    chunks: [],
  }));

  assert.equal(second.id, "second");
  assert.equal((await capture.take()).id, "second");
});

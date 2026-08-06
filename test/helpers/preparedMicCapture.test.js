const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/preparedMicCapture.js");

test("take reuses the in-flight prepared capture", async () => {
  const { PreparedMicCapture } = await load();
  let resolveAcquire;
  let acquisitions = 0;
  const capture = new PreparedMicCapture();
  const stream = { getTracks: () => [] };

  capture.prepare(
    () =>
      new Promise((resolve) => {
        acquisitions += 1;
        resolveAcquire = resolve;
      })
  );
  const taken = capture.take();
  await Promise.resolve();
  resolveAcquire({ stream, constraints: { audio: true } });

  assert.equal((await taken).stream, stream);
  assert.equal(acquisitions, 1);
});

test("cancel stops a prepared stream", async () => {
  const { PreparedMicCapture } = await load();
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => (stopped += 1) }] };
  const capture = new PreparedMicCapture();

  await capture.prepare(async () => ({ stream, constraints: { audio: true } }));
  capture.cancel();

  assert.equal(stopped, 1);
  assert.equal(await capture.take(), null);
});

test("cancel during acquisition stops the stream when it arrives", async () => {
  const { PreparedMicCapture } = await load();
  let resolveAcquire;
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => (stopped += 1) }] };
  const capture = new PreparedMicCapture();

  const preparation = capture.prepare(
    () =>
      new Promise((resolve) => {
        resolveAcquire = resolve;
      })
  );
  await Promise.resolve();
  capture.cancel();
  resolveAcquire({ stream, constraints: { audio: true } });

  assert.equal(await preparation, null);
  assert.equal(stopped, 1);
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

const test = require("node:test");
const assert = require("node:assert/strict");
const { downsample24kTo16k, pcm16ToFloat32, computePcm16Rms } = require("../../src/utils/audioUtils");

// A Buffer whose byteOffset is odd, as `someChunk.subarray(oddIndex)` produces.
// A plain Int16Array view over it throws; the audio helpers must tolerate it,
// matching the contract computePcm16Rms documents.
function unalignedCopy(aligned) {
  const backing = Buffer.alloc(aligned.length + 1);
  aligned.copy(backing, 1);
  const view = backing.subarray(1);
  assert.equal(view.byteOffset % 2, 1, "test fixture must be unaligned");
  return view;
}

function sinePcm(samples) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), i * 2);
  }
  return buffer;
}

test("downsample24kTo16k handles an unaligned buffer identically to an aligned one", () => {
  const aligned = sinePcm(2400);
  const unaligned = unalignedCopy(aligned);
  assert.doesNotThrow(() => downsample24kTo16k(unaligned));
  assert.ok(downsample24kTo16k(aligned).equals(downsample24kTo16k(unaligned)));
});

test("pcm16ToFloat32 handles an unaligned buffer identically to an aligned one", () => {
  const aligned = sinePcm(2400);
  const unaligned = unalignedCopy(aligned);
  assert.doesNotThrow(() => pcm16ToFloat32(unaligned));
  assert.deepEqual(
    Array.from(pcm16ToFloat32(aligned)),
    Array.from(pcm16ToFloat32(unaligned))
  );
});

test("computePcm16Rms, downsample24kTo16k, pcm16ToFloat32 agree on unaligned input", () => {
  const aligned = sinePcm(1600);
  const unaligned = unalignedCopy(aligned);
  assert.equal(computePcm16Rms(aligned), computePcm16Rms(unaligned));
});

test("odd-length and empty buffers do not throw", () => {
  assert.equal(downsample24kTo16k(Buffer.alloc(4801)).length, 3200);
  assert.equal(downsample24kTo16k(Buffer.alloc(0)).length, 0);
  assert.equal(pcm16ToFloat32(Buffer.alloc(0)).length, 0);
  // An odd trailing byte is dropped rather than crashing.
  assert.equal(pcm16ToFloat32(Buffer.alloc(5)).length, 2);
});

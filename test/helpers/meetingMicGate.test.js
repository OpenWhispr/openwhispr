const test = require("node:test");
const assert = require("node:assert/strict");

const gate = require("../../src/helpers/meetingMicGate");
const fx = require("./harness/pcmFixtures");

test("computeChunkStats matches the inline RMS/peak math (Int16 / 0x7fff)", () => {
  const buf = fx.toInt16Buffer(new Float32Array([0.5, -0.5, 0.25, -0.25]));
  const { rms, peak, sampleCount } = gate.computeChunkStats(buf);
  assert.equal(sampleCount, 4);
  assert.ok(Math.abs(peak - 16384 / 0x7fff) < 1e-6);
  const expectedRms = Math.sqrt(((16384 / 0x7fff) ** 2 * 2 + (8192 / 0x7fff) ** 2 * 2) / 4);
  assert.ok(Math.abs(rms - expectedRms) < 1e-6);
});

test("computeChunkStats returns zeros for buffers shorter than one sample", () => {
  assert.deepEqual(gate.computeChunkStats(Buffer.alloc(1)), { rms: 0, peak: 0, sampleCount: 0 });
  assert.deepEqual(gate.computeChunkStats(Buffer.alloc(0)), { rms: 0, peak: 0, sampleCount: 0 });
});

test("computeChunkStats honours byteOffset on subarray views (matches a fresh copy of the same samples)", () => {
  const track = new Float32Array([0.5, -0.5, 0.25, -0.25, 0.75, -0.75]);
  const view = fx.chunkBuffer(fx.toInt16Buffer(track), 3)[1]; // second 3-sample chunk, byteOffset 6
  assert.ok(view.byteOffset > 0, `fixture must be an offset view (byteOffset ${view.byteOffset})`);
  const copy = Buffer.from(view); // fresh buffer, byteOffset 0, same bytes
  assert.deepEqual(gate.computeChunkStats(view), gate.computeChunkStats(copy));
  assert.equal(gate.computeChunkStats(view).sampleCount, 3);
});

const cases = [
  // [label, mode, source, rms, peak, systemSpeaking, expected]
  [
    "streaming mic silence zeroes",
    "streaming",
    "mic",
    0.001,
    0.04,
    false,
    { action: "zero", reason: "silence" },
  ],
  [
    "streaming mic silence needs BOTH rms and peak below",
    "streaming",
    "mic",
    0.001,
    0.06,
    false,
    { action: "send", reason: null },
  ],
  [
    "streaming mic exactly at the silence rms floor is not silent (strict <)",
    "streaming",
    "mic",
    0.0015,
    0.04,
    false,
    { action: "send", reason: null },
  ],
  [
    "streaming mic exactly at the silence peak floor is not silent (strict <)",
    "streaming",
    "mic",
    0.001,
    0.05,
    false,
    { action: "send", reason: null },
  ],
  [
    "streaming mic quiet + system speaking zeroes (bleed floor)",
    "streaming",
    "mic",
    0.01,
    0.06,
    true,
    { action: "zero", reason: "bleed_floor" },
  ],
  [
    "streaming mic quiet + system silent sends",
    "streaming",
    "mic",
    0.01,
    0.06,
    false,
    { action: "send", reason: null },
  ],
  [
    "streaming mic at the rms ceiling is not quiet (strict <)",
    "streaming",
    "mic",
    0.018,
    0.06,
    true,
    { action: "send", reason: null },
  ],
  [
    "streaming mic at the peak ceiling is not quiet (strict <)",
    "streaming",
    "mic",
    0.01,
    0.07,
    true,
    { action: "send", reason: null },
  ],
  [
    "streaming loud mic sends",
    "streaming",
    "mic",
    0.1,
    0.5,
    true,
    { action: "send", reason: null },
  ],
  [
    "streaming system source is never gated",
    "streaming",
    "system",
    0.0,
    0.0,
    true,
    { action: "send", reason: null },
  ],
  [
    "local silence skips any source",
    "local",
    "system",
    0.001,
    0.04,
    false,
    { action: "skip", reason: "silence" },
  ],
  [
    "local mic quiet + system speaking skips (system-dominant)",
    "local",
    "mic",
    0.01,
    0.06,
    true,
    { action: "skip", reason: "system_dominant" },
  ],
  [
    "local system quiet + system speaking is not gated",
    "local",
    "system",
    0.01,
    0.06,
    true,
    { action: "send", reason: null },
  ],
  ["local loud mic sends", "local", "mic", 0.1, 0.5, true, { action: "send", reason: null }],
];

for (const [label, mode, source, rms, peak, systemSpeaking, expected] of cases) {
  test(`resolveMicChunkAction: ${label}`, () => {
    const verdict = gate.resolveMicChunkAction({
      mode,
      source,
      rms,
      peak,
      sampleCount: 800,
      isSystemSpeaking: () => systemSpeaking,
    });
    assert.deepEqual(verdict, expected);
  });
}

test("resolveMicChunkAction sends empty chunks unchanged in both modes", () => {
  for (const mode of ["streaming", "local"]) {
    assert.deepEqual(
      gate.resolveMicChunkAction({
        mode,
        source: "mic",
        rms: 0,
        peak: 0,
        sampleCount: 0,
        isSystemSpeaking: () => true,
      }),
      { action: "send", reason: null }
    );
  }
});

test("resolveMicChunkAction only consults isSystemSpeaking when the chunk is quiet (preserves the local short-circuit)", () => {
  let calls = 0;
  gate.resolveMicChunkAction({
    mode: "local",
    source: "mic",
    rms: 0.5,
    peak: 0.9,
    sampleCount: 800,
    isSystemSpeaking: () => ((calls += 1), true),
  });
  assert.equal(calls, 0);
  gate.resolveMicChunkAction({
    mode: "local",
    source: "mic",
    rms: 0.01,
    peak: 0.06,
    sampleCount: 800,
    isSystemSpeaking: () => ((calls += 1), false),
  });
  assert.equal(calls, 1);
});

test("exports the exact production thresholds", () => {
  assert.equal(gate.MEETING_MIC_SILENCE_RMS, 0.0015);
  assert.equal(gate.MEETING_MIC_SILENCE_PEAK, 0.05);
  assert.equal(gate.MEETING_MIC_BLEED_RMS_CEILING, 0.018);
  assert.equal(gate.MEETING_MIC_BLEED_PEAK_CEILING, 0.07);
});

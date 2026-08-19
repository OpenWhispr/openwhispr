const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.
const load = () => import("../../src/utils/audioDeviceUtils.ts");

test("a phone microphone is never classified as built-in", async () => {
  const { isBuiltInMicrophone } = await load();

  // The bug this pins down: a label like "Galaxy Cell Microphone" (a phone
  // connected to the computer) contains "microphone" and matched none of the
  // external keywords, so the app classified it built-in, auto-selected it,
  // and cached it. Dictation then streamed distant phone-mic audio and the
  // ASR returned empty transcripts.
  assert.equal(isBuiltInMicrophone("Galaxy Cell Microphone"), false);
  assert.equal(isBuiltInMicrophone("Someone's Phone Microphone"), false);
  assert.equal(isBuiltInMicrophone("iPhone Microphone"), false);
  assert.equal(isBuiltInMicrophone("Continuity Camera Microphone"), false);
});

test("genuine built-in microphones stay built-in", async () => {
  const { isBuiltInMicrophone } = await load();

  assert.equal(isBuiltInMicrophone("MacBook Pro Microphone"), true);
  assert.equal(isBuiltInMicrophone("Default - MacBook Pro Microphone (Built-in)"), true);
  // Windows-style labels rely on the generic "microphone" fallback — the fix
  // must not break them.
  assert.equal(isBuiltInMicrophone("Microphone (Realtek High Definition Audio)"), true);
  assert.equal(isBuiltInMicrophone("Microphone Array (Intel Smart Sound)"), true);
  assert.equal(isBuiltInMicrophone("Internal Microphone"), true);
});

test("headphone and headset microphones are external", async () => {
  const { isBuiltInMicrophone } = await load();

  // "phone" (added for cell phones) also matches "headphones" — and that is
  // correct: a headphone mic is external either way. Misclassifying external
  // as built-in is the harmful direction; the reverse only skips a fallback.
  assert.equal(isBuiltInMicrophone("Wired Headphones Microphone"), false);
  assert.equal(isBuiltInMicrophone("USB Headset Microphone"), false);
  assert.equal(isBuiltInMicrophone("AirPods Pro"), false);
});

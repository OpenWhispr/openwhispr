const test = require("node:test");
const assert = require("node:assert/strict");

const en = require("../../src/locales/en/translation.json");

const load = () => import("../../src/components/notes/shared.ts");

// Codes chunkedCloudTranscribe and interpretTranscribeResponse surface to the
// upload UI. Anything added there needs a locale key or it reaches the user as
// a raw English main-process string.
const MAPPED_CODES = ["NO_SPEECH_DETECTED", "CHUNK_LOSS_EXCEEDED", "CUSTOM_ENDPOINT_INVALID"];

test("every mapped code resolves to a key that exists in en", async () => {
  const { transcriptionErrorKey } = await load();

  for (const code of MAPPED_CODES) {
    const key = transcriptionErrorKey({ code });
    assert.ok(key, `${code} has no i18n key`);
    assert.ok(en.notes.upload[key], `notes.upload.${key} is missing from en`);
  }
});

// OpenWhispr Cloud rethrows coded failures through withSessionRefresh, so the
// upload views only see them in a catch block — resolving from the returned
// result alone silently left cloud users with the raw English message.
test("a thrown failure resolves the same key as a returned one", async () => {
  const { transcriptionErrorKey } = await load();

  const thrown = Object.assign(new Error("12 of 19 audio segments were lost"), {
    code: "CHUNK_LOSS_EXCEEDED",
  });
  assert.equal(transcriptionErrorKey(thrown), "chunkLossExceeded");
  assert.equal(transcriptionErrorKey({ code: "CHUNK_LOSS_EXCEEDED" }), "chunkLossExceeded");
});

test("unmapped, codeless and absent failures fall through to the raw message", async () => {
  const { transcriptionErrorKey } = await load();

  assert.equal(transcriptionErrorKey({ code: "SERVER_ERROR" }), undefined);
  assert.equal(transcriptionErrorKey(new Error("boom")), undefined);
  assert.equal(transcriptionErrorKey(null), undefined);
  assert.equal(transcriptionErrorKey(undefined), undefined);
});

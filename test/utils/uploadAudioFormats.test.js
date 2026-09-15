const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isSupportedUploadFile,
  uploadFileUrlPattern,
} = require("../../src/utils/uploadAudioFormats.ts");
const { UPLOAD_AUDIO_EXTENSIONS } = require("../../src/constants/uploadAudioFormats.json");

const LEGACY_EXTENSIONS = ["mp3", "wav", "m4a", "webm", "ogg", "oga", "flac", "aac", "opus"];

test("the upload extension list is lowercase, unique, and still admits every legacy format", () => {
  assert.deepEqual(
    UPLOAD_AUDIO_EXTENSIONS,
    UPLOAD_AUDIO_EXTENSIONS.map((ext) => ext.toLowerCase())
  );
  assert.equal(new Set(UPLOAD_AUDIO_EXTENSIONS).size, UPLOAD_AUDIO_EXTENSIONS.length);
  for (const ext of LEGACY_EXTENSIONS) assert.ok(UPLOAD_AUDIO_EXTENSIONS.includes(ext), ext);
});

test("isSupportedUploadFile keys off the final extension, case-insensitively", () => {
  assert.equal(isSupportedUploadFile("standup.mp3"), true);
  assert.equal(isSupportedUploadFile("Screen Recording.MOV"), true);
  assert.equal(isSupportedUploadFile("lecture.mpeg"), true);
  assert.equal(isSupportedUploadFile("voice memo.m4a"), true);
  assert.equal(isSupportedUploadFile("interview.2024.aiff"), true);
  assert.equal(isSupportedUploadFile("notes.txt"), false);
  assert.equal(isSupportedUploadFile("clip.mp4.part"), false);
  assert.equal(isSupportedUploadFile("README"), false);
  assert.equal(isSupportedUploadFile(".mp3"), false);
});

test("uploadFileUrlPattern recognises direct file links with or without a query string", () => {
  assert.equal(uploadFileUrlPattern.test("https://cdn.example.com/talk.mp4?token=abc"), true);
  assert.equal(uploadFileUrlPattern.test("https://cdn.example.com/talk.MKV"), true);
  assert.equal(uploadFileUrlPattern.test("https://cdn.example.com/talk.mp3"), true);
  assert.equal(uploadFileUrlPattern.test("https://www.youtube.com/watch?v=abc"), false);
  assert.equal(uploadFileUrlPattern.test("https://cdn.example.com/talk.mp3x"), false);
});

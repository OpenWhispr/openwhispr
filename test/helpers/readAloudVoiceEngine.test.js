const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  SUPERTONIC_FILES,
  KOKORO_FILES,
  hasRequiredFiles,
  buildModelConfig,
  buildGenerationRequest,
  modelKey,
} = require("../../src/helpers/readAloud/voiceEngine");
const {
  VOICES,
  defaultVoiceFor,
  getVoice,
  getVoiceArchive,
  getVoiceUrl,
  shareVoiceFiles,
} = require("../../src/helpers/readAloud/voices");

const piper = { id: "vits-piper-pt_BR-faber-medium", engine: "piper" };
const sam = getVoice("sherpa-onnx-supertonic-3-tts-int8-2026-05-11");
const dora = getVoice("kokoro-pt_BR-dora");
const alex = getVoice("kokoro-pt_BR-alex");

test("catalog offers Sam on Supertonic", () => {
  assert.equal(sam.engine, "supertonic");
  assert.equal(sam.sid, 8); // M4 in F1..F5, M1..M5 order
  assert.equal(sam.numSteps, 16);
  assert.equal(sam.lang, "pt");
});

test("piper voices need model, tokens and espeak data", () => {
  assert.equal(hasRequiredFiles(piper, ["a.onnx", "tokens.txt", "espeak-ng-data"]), true);
  assert.equal(hasRequiredFiles(piper, ["a.onnx", "tokens.txt"]), false);
});

test("supertonic voices need every graph and asset", () => {
  const all = Object.values(SUPERTONIC_FILES);
  assert.equal(hasRequiredFiles(sam, all), true);
  assert.equal(hasRequiredFiles(sam, all.slice(1)), false);
});

test("builds a VITS config for piper", () => {
  const cfg = buildModelConfig(piper, "/voices/faber", 2, () => ["pt_BR-faber-medium.onnx"]);
  assert.equal(cfg.model.vits.model, path.join("/voices/faber", "pt_BR-faber-medium.onnx"));
  assert.equal(cfg.model.numThreads, 2);
  assert.equal(cfg.model.supertonic, undefined);
});

test("builds a Supertonic config with all file paths", () => {
  const cfg = buildModelConfig(sam, "/voices/st3", 6);
  assert.equal(cfg.model.supertonic.voiceStyle, path.join("/voices/st3", "voice.bin"));
  assert.equal(cfg.model.supertonic.ttsJson, path.join("/voices/st3", "tts.json"));
  assert.equal(cfg.model.numThreads, 6);
  assert.equal(cfg.model.vits, undefined);
});

test("supertonic requests carry speaker, steps and language", () => {
  const req = buildGenerationRequest(sam, "Olá.", 1.25);
  assert.equal(req.enableExternalBuffer, false);
  assert.deepEqual(req.generationConfig, {
    sid: 8,
    speed: 1.25,
    numSteps: 16,
    extra: { lang: "pt" },
  });
});

test("piper requests stay plain", () => {
  const req = buildGenerationRequest(piper, "Olá.", 1);
  assert.deepEqual(req, { text: "Olá.", sid: 0, speed: 1, enableExternalBuffer: false });
});

test("catalog offers Dora and Alex as Brazilian Kokoro speakers", () => {
  assert.equal(dora.engine, "kokoro");
  assert.equal(alex.engine, "kokoro");
  assert.equal(dora.sid, 42); // pf_dora
  assert.equal(alex.sid, 43); // pm_alex
  assert.equal(dora.lang, "pt-br");
  assert.equal(alex.lang, "pt-br");
});

test("Kokoro voices share one archive, directory and download", () => {
  assert.equal(getVoiceArchive(dora.id), "kokoro-multi-lang-v1_0");
  assert.equal(getVoiceArchive(alex.id), "kokoro-multi-lang-v1_0");
  assert.equal(getVoiceUrl(dora.id), getVoiceUrl(alex.id));
  assert.match(getVoiceUrl(dora.id), /\/kokoro-multi-lang-v1_0\.tar\.bz2$/);
  assert.equal(shareVoiceFiles(dora.id, alex.id), true);
  assert.equal(shareVoiceFiles(dora.id, sam.id), false);
  assert.equal(shareVoiceFiles(dora.id, null), false);
});

test("voices without an archive keep using their id", () => {
  assert.equal(getVoiceArchive(piper.id), piper.id);
  assert.match(getVoiceUrl(piper.id), /\/vits-piper-pt_BR-faber-medium\.tar\.bz2$/);
  assert.equal(shareVoiceFiles(piper.id, piper.id), true);
});

test("catalog ids are unique", () => {
  const ids = VOICES.map((voice) => voice.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("kokoro voices need model, voices, tokens and espeak data", () => {
  const all = Object.values(KOKORO_FILES);
  assert.equal(hasRequiredFiles(dora, all), true);
  assert.equal(
    hasRequiredFiles(
      dora,
      all.filter((name) => name !== "voices.bin")
    ),
    false
  );
});

test("builds a Kokoro config in Portuguese without the English lexicons", () => {
  const cfg = buildModelConfig(dora, "/voices/kokoro", 2);
  assert.equal(cfg.model.kokoro.model, path.join("/voices/kokoro", "model.onnx"));
  assert.equal(cfg.model.kokoro.voices, path.join("/voices/kokoro", "voices.bin"));
  assert.equal(cfg.model.kokoro.dataDir, path.join("/voices/kokoro", "espeak-ng-data"));
  assert.equal(cfg.model.kokoro.lang, "pt-br");
  assert.equal(cfg.model.kokoro.lexicon, undefined);
  assert.equal(cfg.model.numThreads, 2);
  assert.equal(cfg.model.vits, undefined);
});

test("kokoro requests carry the speaker id", () => {
  assert.deepEqual(buildGenerationRequest(alex, "Olá.", 1), {
    text: "Olá.",
    sid: 43,
    speed: 1,
    enableExternalBuffer: false,
  });
});

test("default voice follows the UI language, English otherwise", () => {
  assert.equal(defaultVoiceFor("pt"), "vits-piper-pt_BR-faber-medium");
  assert.equal(defaultVoiceFor("pt-BR"), "vits-piper-pt_BR-faber-medium");
  assert.equal(defaultVoiceFor("en"), "kokoro-en_US-heart");
  assert.equal(defaultVoiceFor("ja"), "kokoro-en_US-heart");
  assert.equal(defaultVoiceFor(undefined), "kokoro-en_US-heart");
});

test("every voice declares the language it speaks", () => {
  for (const voice of VOICES) assert.ok(["pt", "en"].includes(voice.language), voice.id);
});

test("English Kokoro speakers use the US lexicon, Portuguese ones none", () => {
  const dir = path.join("cache", "kokoro-multi-lang-v1_0");
  const heart = buildModelConfig(getVoice("kokoro-en_US-heart"), dir, 2).model.kokoro;
  assert.equal(heart.lang, "en-us");
  assert.equal(heart.lexicon, path.join(dir, "lexicon-us-en.txt"));
  assert.equal(
    buildModelConfig(getVoice("kokoro-pt_BR-dora"), dir, 2).model.kokoro.lexicon,
    undefined
  );
});

test("switching Kokoro speakers reloads the model only when the language changes", () => {
  const dir = "kokoro";
  const key = (id) => modelKey(getVoice(id), dir);
  assert.equal(key("kokoro-pt_BR-dora"), key("kokoro-pt_BR-alex"));
  assert.equal(key("kokoro-en_US-heart"), key("kokoro-en_US-michael"));
  assert.notEqual(key("kokoro-pt_BR-dora"), key("kokoro-en_US-heart"));
  assert.equal(modelKey(getVoice("vits-piper-pt_BR-faber-medium"), "faber"), "faber");
});

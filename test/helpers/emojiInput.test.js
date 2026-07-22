const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

let loaded;
const load = () => {
  if (!loaded) {
    const filename = path.join(__dirname, "../../src/lib/emojiInput.ts");
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    loaded = import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  }
  return loaded;
};

test("empty and whitespace-only input clamps to empty", async () => {
  const { clampEmojiInput } = await load();
  assert.equal(clampEmojiInput(""), "");
  assert.equal(clampEmojiInput("   "), "");
});

test("keeps a single simple emoji", async () => {
  const { clampEmojiInput } = await load();
  assert.equal(clampEmojiInput("😀"), "😀");
});

test("preserves multi-code-unit emoji that maxLength=4 used to reject", async () => {
  const { clampEmojiInput } = await load();
  // ZWJ sequence: 5 UTF-16 code units
  assert.equal(clampEmojiInput("🧑‍💻"), "🧑‍💻");
  // Family ZWJ sequence: 8 UTF-16 code units
  assert.equal(clampEmojiInput("👨‍👩‍👧"), "👨‍👩‍👧");
  // Skin-tone modifier: 4 UTF-16 code units
  assert.equal(clampEmojiInput("👍🏽"), "👍🏽");
  // Regional indicator flag
  assert.equal(clampEmojiInput("🇩🇪"), "🇩🇪");
});

test("typing after an existing emoji replaces it with the new one", async () => {
  const { clampEmojiInput } = await load();
  assert.equal(clampEmojiInput("😀🚀"), "🚀");
  assert.equal(clampEmojiInput("🚀👨‍👩‍👧"), "👨‍👩‍👧");
});

test("plain text clamps to its last character", async () => {
  const { clampEmojiInput } = await load();
  assert.equal(clampEmojiInput("ab"), "b");
});

test("surrounding whitespace is ignored", async () => {
  const { clampEmojiInput } = await load();
  assert.equal(clampEmojiInput(" 🚀 "), "🚀");
});

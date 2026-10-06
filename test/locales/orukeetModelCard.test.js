const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const locales = path.resolve(__dirname, "../../src/locales");
for (const locale of fs.readdirSync(locales)) {
  const file = path.join(locales, locale, "translation.json");
  if (!fs.existsSync(file)) continue;
  test(`${locale} resolves the Orukeet card copy at the component's translation keys`, () => {
    const translation = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(typeof translation.transcription.modelCard, "string");
    assert.ok(translation.transcription.modelCard.trim());
    assert.ok(translation.models.descriptions.parakeet.orukeet.trim());
  });
}

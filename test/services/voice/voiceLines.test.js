const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SPOKEN_LANGUAGES,
  detectSpokenLanguage,
  preparedLines,
  toolFiller,
} = require("../../../src/services/voice/voiceLines");

test("every call language has every line, and the fillers are among the prepared lines", () => {
  for (const language of SPOKEN_LANGUAGES) {
    const lines = preparedLines(language);
    assert.equal(lines.length, 5, language);
    assert.ok(
      lines.every((line) => line.length > 0 && line.length <= 200),
      language
    );
    for (const tools of [["web_search"], ["search_notes"], ["get_calendar_events"], ["x"]]) {
      assert.ok(lines.includes(toolFiller(tools, language)), `${language} ${tools}`);
    }
  }
});

test("the filler names the slowest kind of tool the step runs", () => {
  assert.equal(toolFiller(["search_notes", "web_search"], "en"), "Let me look that up.");
  assert.equal(toolFiller(["get_note"], "es"), "Déjame revisar tus notas.");
  assert.equal(toolFiller(["get_calendar_availability"], "de"), "Ich sehe in deinen Kalender.");
  assert.equal(toolFiller(["create_note"], "fr"), "Un instant.");
});

test("a reply's language is told by its script, letters and common words", () => {
  assert.equal(detectSpokenLanguage("ज़रूर, कल आपकी दो मीटिंग हैं।"), "hi");
  assert.equal(detectSpokenLanguage("Claro, mañana tienes dos reuniones."), "es");
  assert.equal(detectSpokenLanguage("Bien sûr, vous avez deux réunions demain."), "fr");
  assert.equal(detectSpokenLanguage("Klar, morgen früh hast du zwei Termine."), "de");
  assert.equal(detectSpokenLanguage("Sure, you have two meetings tomorrow."), "en");
  assert.equal(detectSpokenLanguage("Okay."), null);
});

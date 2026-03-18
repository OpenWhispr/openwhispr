const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { removeFillers } = require("../../src/helpers/sonioxStreaming");

describe("removeFillers", () => {
  it("passes through normal text unchanged", () => {
    assert.equal(removeFillers("Hello world."), "Hello world.");
  });

  it("removes filler mid-sentence", () => {
    assert.equal(removeFillers("I uh think so"), "I think so");
  });

  it("removes filler with trailing comma mid-sentence", () => {
    assert.equal(removeFillers("I, um, think so"), "I think so");
  });

  it("removes filler after period and capitalizes next word", () => {
    assert.equal(
      removeFillers("done. Yyy, let me check"),
      "done. Let me check"
    );
  });

  it("removes filler after question mark and capitalizes", () => {
    assert.equal(
      removeFillers("right? Eee, or maybe not"),
      "right? Or maybe not"
    );
  });

  it("removes filler after exclamation mark and capitalizes", () => {
    assert.equal(
      removeFillers("wow! Um, that was great"),
      "wow! That was great"
    );
  });

  it("preserves 'Hmm' as intentional expression", () => {
    assert.equal(
      removeFillers("really? Hmm. Maybe so."),
      "really? Hmm. Maybe so."
    );
  });

  it("removes multiple fillers in one text", () => {
    assert.equal(
      removeFillers("OK so let's try. Yyy, does it work? Um, or not? Eee, let me check again."),
      "OK so let's try. Does it work? Or not? Let me check again."
    );
  });

  it("removes filler at start of text and capitalizes", () => {
    assert.equal(removeFillers("Uh, so anyway"), "So anyway");
  });

  it("removes filler at end of text", () => {
    assert.equal(removeFillers("That's all um"), "That's all");
  });

  it("removes consecutive fillers", () => {
    assert.equal(removeFillers("Well uh um ok"), "Well ok");
  });

  it("handles text with only fillers", () => {
    assert.equal(removeFillers("Uh um mmm"), "");
  });

  it("handles empty string", () => {
    assert.equal(removeFillers(""), "");
  });

  it("is case-insensitive", () => {
    assert.equal(removeFillers("So UH yeah"), "So yeah");
    assert.equal(removeFillers("So UHH yeah"), "So yeah");
    assert.equal(removeFillers("So YYY yeah"), "So yeah");
  });

  it("handles filler variations with repeated letters", () => {
    assert.equal(removeFillers("So uhhh yeah"), "So yeah");
    assert.equal(removeFillers("So ummm yeah"), "So yeah");
    assert.equal(removeFillers("So hmmm yeah"), "So hmmm yeah");
    assert.equal(removeFillers("So eeeee yeah"), "So yeah");
    assert.equal(removeFillers("So yyyy yeah"), "So yeah");
  });

  // False positive protection: real words must NOT be removed

  it("preserves real words containing filler substrings", () => {
    assert.equal(removeFillers("The umbrella is here."), "The umbrella is here.");
    assert.equal(removeFillers("She is human."), "She is human.");
    assert.equal(removeFillers("Check the ohms."), "Check the ohms.");
    assert.equal(removeFillers("It is yummy."), "It is yummy.");
    assert.equal(removeFillers("Hot summer day."), "Hot summer day.");
  });

  it("preserves 'Oh' as a real exclamation", () => {
    assert.equal(removeFillers("Oh really?"), "Oh really?");
    assert.equal(removeFillers("Oh, that is nice."), "Oh, that is nice.");
    assert.equal(removeFillers("oh no!"), "oh no!");
    assert.equal(removeFillers("Hello. Oh, nice!"), "Hello. Oh, nice!");
  });

  it("preserves 'Ah' as a real exclamation", () => {
    assert.equal(removeFillers("Ah, I see."), "Ah, I see.");
    assert.equal(removeFillers("done. Ah, great."), "done. Ah, great.");
  });

  it("preserves short tokens like 'ee' and 'hm'", () => {
    assert.equal(removeFillers("I see ee in the code"), "I see ee in the code");
    assert.equal(removeFillers("Hm, interesting."), "Hm, interesting.");
  });

  // Unicode capitalization

  it("capitalizes Unicode letters after filler at sentence boundary", () => {
    assert.equal(
      removeFillers("done. Yyy, ćwiczenie. Eee, ósmy. Um, świetnie"),
      "done. Ćwiczenie. Ósmy. Świetnie"
    );
  });

  it("capitalizes accented Latin letters after filler", () => {
    assert.equal(
      removeFillers("bien. Um, él sabe"),
      "bien. Él sabe"
    );
  });

  it("capitalizes Cyrillic letters after filler", () => {
    assert.equal(
      removeFillers("done. Uhh, это работает"),
      "done. Это работает"
    );
  });

  it("does not capitalize mid-sentence after filler removal", () => {
    assert.equal(removeFillers("I uh think so"), "I think so");
    assert.equal(removeFillers("let's um try"), "let's try");
  });

  it("does not capitalize first letter when no leading filler was removed", () => {
    assert.equal(removeFillers("iPhone is great"), "iPhone is great");
  });

  // Realistic Soniox output

  it("handles realistic Soniox output with multiple fillers", () => {
    assert.equal(
      removeFillers("OK so let me think. Yyy, does this work? Hmm. Maybe it does. Eee, let me check one more time."),
      "OK so let me think. Does this work? Hmm. Maybe it does. Let me check one more time."
    );
  });

  // Sentence boundary preservation

  it("preserves period when filler is mid-sentence with comma before", () => {
    assert.equal(
      removeFillers("I think, uh. Let me check."),
      "I think. Let me check."
    );
  });

  it("preserves period with lowercase next word and capitalizes", () => {
    assert.equal(
      removeFillers("it works, um. but not always."),
      "it works. But not always."
    );
  });

  it("removes period when filler is standalone sentence", () => {
    assert.equal(
      removeFillers("really? Uh. Maybe so."),
      "really? Maybe so."
    );
  });

  it("removes period when filler is at end of text", () => {
    assert.equal(removeFillers("that is all uh."), "that is all");
  });
});

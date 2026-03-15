import { describe, it, expect } from "vitest";
import { extractCorrections } from "../correctionLearner";

describe("extractCorrections", () => {
  it("returns empty array for null/empty inputs", () => {
    expect(extractCorrections(null, "hello", [])).toEqual([]);
    expect(extractCorrections("hello", null, [])).toEqual([]);
    expect(extractCorrections("", "hello", [])).toEqual([]);
    expect(extractCorrections("hello", "", [])).toEqual([]);
  });

  it("returns empty array when texts are identical", () => {
    expect(extractCorrections("hello world", "hello world", [])).toEqual([]);
  });

  it("detects a simple word substitution", () => {
    // "Shunade" is a phonetic mishearing of "Sinead"
    const original = "Hey Shunade how are you";
    const edited = "Hey Sinead how are you";
    const result = extractCorrections(original, edited, []);
    expect(result).toContain("Sinead");
  });

  it("ignores corrections already in the dictionary", () => {
    const original = "Hey Shunade how are you";
    const edited = "Hey Sinead how are you";
    const result = extractCorrections(original, edited, ["Sinead"]);
    expect(result).not.toContain("Sinead");
  });

  it("ignores case when checking dictionary", () => {
    const original = "Hey Shunade how are you";
    const edited = "Hey Sinead how are you";
    const result = extractCorrections(original, edited, ["sinead"]);
    expect(result).not.toContain("Sinead");
  });

  it("returns empty array when more than 50% of words changed (rewrite)", () => {
    const original = "the cat sat on the mat";
    const edited = "a dog stood under a rug";
    const result = extractCorrections(original, edited, []);
    expect(result).toEqual([]);
  });

  it("filters out very short corrections (less than 3 characters)", () => {
    const original = "I went to see XX today";
    const edited = "I went to see Al today";
    const result = extractCorrections(original, edited, []);
    expect(result).not.toContain("Al");
  });

  it("filters out unrelated word replacements (high edit distance)", () => {
    // "cat" → "elephant" is too distant
    const original = "I saw a cat yesterday";
    const edited = "I saw a elephant yesterday";
    const result = extractCorrections(original, edited, []);
    expect(result).not.toContain("elephant");
  });

  it("handles non-array dictionary gracefully", () => {
    const original = "Hey Shunade";
    const edited = "Hey Sinead";
    // @ts-expect-error testing runtime safety
    const result = extractCorrections(original, edited, null);
    expect(result).toContain("Sinead");
  });

  it("does not return duplicate corrections", () => {
    const original = "Shunade said hi to Shunade";
    const edited = "Sinead said hi to Sinead";
    const result = extractCorrections(original, edited, []);
    const sinead = result.filter((w: string) => w.toLowerCase() === "sinead");
    expect(sinead.length).toBeLessThanOrEqual(1);
  });
});

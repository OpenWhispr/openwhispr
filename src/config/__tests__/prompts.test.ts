import { describe, it, expect } from "vitest";

// detectAgentName and levenshteinDistance are not exported, so we test them
// indirectly through getSystemPrompt, or we can import the module and test
// the observable behavior. Since detectAgentName is private, we test via
// getSystemPrompt's behavior of choosing cleanup vs full prompt based on
// whether the agent name is detected in the transcript.

// For direct testing of the fuzzy matching logic, we'll replicate the
// algorithm contract and test getWordBoost which is exported.

import { getWordBoost } from "../prompts";

describe("getWordBoost", () => {
  it("returns empty array for undefined/null/empty dictionary", () => {
    expect(getWordBoost(undefined)).toEqual([]);
    expect(getWordBoost([])).toEqual([]);
  });

  it("returns non-empty words from dictionary", () => {
    expect(getWordBoost(["hello", "world"])).toEqual(["hello", "world"]);
  });

  it("filters out whitespace-only entries", () => {
    expect(getWordBoost(["hello", "  ", "", "world"])).toEqual(["hello", "world"]);
  });
});

// Test detectAgentName indirectly via getSystemPrompt behavior
// getSystemPrompt uses detectAgentName to decide which prompt template to use.
// When agent name IS detected → uses fullPrompt
// When agent name is NOT detected → uses cleanupPrompt
// We can observe this by checking if the output differs.


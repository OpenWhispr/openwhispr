import { describe, expect, it } from "vitest";

import {
  buildDictionaryPrompt,
  createDictionaryEntriesFromWords,
  getDictionaryPromptBudget,
} from "./dictionaryUtils";

describe("dictionaryUtils", () => {
  it("prioritizes pinned terms and agent names when the prompt budget is tight", () => {
    const selection = buildDictionaryPrompt(
      [
        {
          term: "Archive",
          normalizedTerm: "archive",
          kind: "legacy",
          source: "legacy",
          priority: 1,
          pinned: false,
          enabled: true,
        },
        {
          term: "Nathan",
          normalizedTerm: "nathan",
          kind: "legacy",
          source: "legacy",
          priority: 1,
          pinned: false,
          enabled: true,
        },
        {
          term: "Pinned Term",
          normalizedTerm: "pinned term",
          kind: "technical",
          source: "otter_glossary",
          priority: 1,
          pinned: true,
          enabled: true,
        },
      ],
      {
        maxChars: "Nathan, Pinned Term".length,
        agentName: "Nathan",
      }
    );

    expect(selection.prompt).toBe("Nathan, Pinned Term");
    expect(selection.selectedEntries.map((entry) => entry.term)).toEqual(["Nathan", "Pinned Term"]);
    expect(selection.droppedEntries).toBe(1);
  });

  it("preserves existing metadata when rebuilding entries from plain words", () => {
    const entries = createDictionaryEntriesFromWords(["  OpenWhispr  "], [
      {
        term: "OpenWhispr",
        normalizedTerm: "openwhispr",
        kind: "manual",
        source: "manual",
        priority: 240,
        pinned: true,
        enabled: false,
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      term: "OpenWhispr",
      normalizedTerm: "openwhispr",
      kind: "manual",
      source: "manual",
      priority: 240,
      pinned: true,
      enabled: true,
    });
  });

  it("uses explicit provider budgets with a sensible default fallback", () => {
    expect(getDictionaryPromptBudget("groq")).toBe(896);
    expect(getDictionaryPromptBudget("local-whisper")).toBe(1600);
    expect(getDictionaryPromptBudget("unknown-provider")).toBe(900);
    expect(getDictionaryPromptBudget(null)).toBe(900);
  });
});

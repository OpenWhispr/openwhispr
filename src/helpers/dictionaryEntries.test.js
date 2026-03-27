import { describe, expect, it } from "vitest";

import {
  buildOtterGlossaryEntries,
  createDictionaryEntriesFromWords,
  dedupeDictionaryEntries,
  getDictionaryWords,
} from "./dictionaryEntries.js";

describe("dictionaryEntries", () => {
  it("builds glossary entries while filtering obvious junk", () => {
    const entries = buildOtterGlossaryEntries({
      people: {
        maria: {
          display_name: "Maria Weinert",
          aliases: ["Maria", "Bank accounts", "Maria Weinert"],
        },
        blocked: {
          display_name: "My bank accounts",
        },
        tooLong: {
          display_name: "This Person Name Has Far Too Many Words",
        },
      },
      organizations: {
        ukdri: {
          correct: "UKDRI",
        },
      },
      projects: {
        alphaGenome: {
          name: "AlphaGenome",
        },
      },
      technical_terms: {
        tipSeq: {
          correct: "TIP-seq",
        },
        numeric: {
          correct: "12345",
        },
      },
    });

    const terms = entries.map((entry) => entry.term);

    expect(terms).toEqual(
      expect.arrayContaining(["Maria Weinert", "Maria", "UKDRI", "AlphaGenome", "TIP-seq"])
    );
    expect(terms).not.toContain("My bank accounts");
    expect(terms).not.toContain("Bank accounts");
    expect(terms).not.toContain("12345");
    expect(terms).not.toContain("This Person Name Has Far Too Many Words");
    expect(entries.find((entry) => entry.term === "Maria Weinert")).toMatchObject({
      kind: "person",
      source: "otter_glossary",
      priority: 85,
    });
  });

  it("dedupes entries and only exposes enabled terms to the legacy word list", () => {
    const entries = dedupeDictionaryEntries([
      {
        term: "OpenWhispr",
        normalizedTerm: "openwhispr",
        kind: "legacy",
        source: "legacy",
        priority: 20,
        pinned: false,
        enabled: true,
      },
      {
        term: "openwhispr",
        normalizedTerm: "openwhispr",
        kind: "manual",
        source: "manual",
        priority: 140,
        pinned: true,
        enabled: true,
      },
      {
        term: "Muted Term",
        normalizedTerm: "muted term",
        kind: "manual",
        source: "manual",
        priority: 100,
        pinned: false,
        enabled: false,
      },
    ]);

    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.normalizedTerm === "openwhispr")).toMatchObject({
      priority: 140,
      pinned: true,
    });
    expect(getDictionaryWords(entries)).toEqual(["openwhispr"]);
  });

  it("rebuilds legacy word lists into structured entries without dropping stronger metadata", () => {
    const entries = createDictionaryEntriesFromWords(["  Maria Weinert  ", "OpenWhispr"], [
      {
        term: "Maria Weinert",
        normalizedTerm: "maria weinert",
        kind: "person",
        source: "manual",
        priority: 250,
        pinned: true,
        enabled: false,
      },
    ]);

    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.normalizedTerm === "maria weinert")).toMatchObject({
      kind: "person",
      source: "manual",
      priority: 250,
      pinned: true,
      enabled: true,
    });
    expect(entries.find((entry) => entry.normalizedTerm === "openwhispr")).toMatchObject({
      kind: "manual",
      source: "manual",
      priority: 100,
      pinned: false,
      enabled: true,
    });
  });
});

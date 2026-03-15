import { describe, it, expect } from "vitest";
import { getBaseLanguageCode, validateLanguageForModel, getLanguageInstruction } from "../languageSupport";

describe("getBaseLanguageCode", () => {
  it("returns undefined for null/undefined", () => {
    expect(getBaseLanguageCode(null)).toBeUndefined();
    expect(getBaseLanguageCode(undefined)).toBeUndefined();
  });

  it("returns undefined for 'auto'", () => {
    expect(getBaseLanguageCode("auto")).toBeUndefined();
  });

  it("returns the code itself for simple codes", () => {
    expect(getBaseLanguageCode("en")).toBe("en");
    expect(getBaseLanguageCode("fr")).toBe("fr");
  });

  it("returns base code from regional codes", () => {
    expect(getBaseLanguageCode("zh-CN")).toBe("zh");
    expect(getBaseLanguageCode("pt-BR")).toBe("pt");
    expect(getBaseLanguageCode("en-US")).toBe("en");
  });
});

describe("validateLanguageForModel", () => {
  it("returns undefined for auto/null/undefined", () => {
    expect(validateLanguageForModel("auto", "any-model")).toBeUndefined();
    expect(validateLanguageForModel(null, "any-model")).toBeUndefined();
    expect(validateLanguageForModel(undefined, "any-model")).toBeUndefined();
  });

  it("returns base code for unknown models (no restriction)", () => {
    expect(validateLanguageForModel("en", "unknown-model")).toBe("en");
    expect(validateLanguageForModel("fr", "unknown-model")).toBe("fr");
  });

  it("validates language against parakeet model supported set", () => {
    // Parakeet supports a specific set of languages
    const result = validateLanguageForModel("en", "parakeet-tdt-0.6b-v3");
    expect(result).toBe("en");
  });

  it("returns undefined for unsupported language on parakeet", () => {
    // Parakeet does not support Afrikaans (af is whisper-only per registry)
    const result = validateLanguageForModel("af", "parakeet-tdt-0.6b-v3");
    expect(result).toBeUndefined();
  });
});

describe("getLanguageInstruction", () => {
  it("returns empty string for undefined", () => {
    expect(getLanguageInstruction(undefined)).toBe("");
  });

  it("returns instruction for 'auto' (has explicit instruction in registry)", () => {
    const result = getLanguageInstruction("auto");
    expect(result).toContain("auto-detect");
  });

  it("returns instruction for languages with explicit instructions", () => {
    const result = getLanguageInstruction("ar");
    expect(result).toContain("Arabic");
  });

  it("returns generic instruction for languages without explicit instruction", () => {
    // Afrikaans has no explicit instruction, should use generic template
    const result = getLanguageInstruction("af");
    expect(result).toContain("af");
  });
});

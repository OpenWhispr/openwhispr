import { describe, it, expect } from "vitest";
import { normalizeBaseUrl, buildApiUrl } from "../constants";

describe("normalizeBaseUrl", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(normalizeBaseUrl(null)).toBe("");
    expect(normalizeBaseUrl(undefined)).toBe("");
    expect(normalizeBaseUrl("")).toBe("");
    expect(normalizeBaseUrl("   ")).toBe("");
  });

  it("strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://api.example.com/")).toBe("https://api.example.com");
    expect(normalizeBaseUrl("https://api.example.com///")).toBe("https://api.example.com");
  });

  it("strips /v1/chat/completions suffix, keeping /v1", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1"
    );
  });

  it("strips /chat/completions suffix entirely", () => {
    expect(normalizeBaseUrl("https://api.example.com/chat/completions")).toBe(
      "https://api.example.com"
    );
  });

  it("strips /v1/responses suffix, keeping /v1", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/responses")).toBe(
      "https://api.example.com/v1"
    );
  });

  it("strips /v1/models suffix, keeping /v1", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/models")).toBe(
      "https://api.example.com/v1"
    );
  });

  it("strips /v1/audio/transcriptions suffix, keeping /v1", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/audio/transcriptions")).toBe(
      "https://api.example.com/v1"
    );
  });

  it("strips /audio/transcriptions suffix", () => {
    expect(normalizeBaseUrl("https://api.example.com/audio/transcriptions")).toBe(
      "https://api.example.com"
    );
  });

  it("leaves a clean base URL unchanged", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
  });

  it("is case-insensitive for suffix matching", () => {
    // The regex match is case-insensitive but the replacement is hardcoded "/v1"
    const result = normalizeBaseUrl("https://api.example.com/V1/Chat/Completions");
    expect(result).toBe("https://api.example.com/v1");
  });
});

describe("buildApiUrl", () => {
  it("appends path to base", () => {
    expect(buildApiUrl("https://api.openai.com/v1", "/responses")).toBe(
      "https://api.openai.com/v1/responses"
    );
  });

  it("adds leading slash if missing", () => {
    expect(buildApiUrl("https://api.openai.com/v1", "responses")).toBe(
      "https://api.openai.com/v1/responses"
    );
  });

  it("falls back to OpenAI default when base is empty", () => {
    expect(buildApiUrl("", "/responses")).toBe("https://api.openai.com/v1/responses");
  });

  it("normalizes the base before appending", () => {
    expect(
      buildApiUrl("https://api.example.com/v1/chat/completions", "/responses")
    ).toBe("https://api.example.com/v1/responses");
  });

  it("returns just the base when path is empty", () => {
    expect(buildApiUrl("https://api.openai.com/v1", "")).toBe(
      "https://api.openai.com/v1"
    );
  });
});

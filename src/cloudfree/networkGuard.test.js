import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "module";

// Use createRequire to load the CJS module natively, bypassing vitest's
// ESM transform which misparses the JSDoc comment containing /*/resolve/main/*
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

const require = createRequire(import.meta.url);
const { checkUrl, loadAllowlist } = require("./networkGuard.js");

describe("loadAllowlist", () => {
  it("loads and parses the allowlist JSON", () => {
    const allowlist = loadAllowlist();
    expect(allowlist).toHaveProperty("version", 2);
    expect(allowlist).toHaveProperty("rules");
    expect(allowlist.rules).toHaveProperty("ai_providers");
    expect(allowlist.rules).toHaveProperty("model_downloads");
    expect(allowlist.rules).toHaveProperty("local");
  });
});

describe("checkUrl", () => {
  describe("internal URLs", () => {
    it.each([
      ["data:text/html,<h1>hello</h1>"],
      ["data:image/png;base64,abc123"],
      ["file:///Users/test/index.html"],
      ["devtools://devtools/bundled/inspector.html"],
      ["chrome-extension://abc123/popup.html"],
    ])("allows %s as internal", (url) => {
      const result = checkUrl(url);
      expect(result).toEqual({ allowed: true, reason: "internal" });
    });
  });

  describe("allowed AI provider URLs", () => {
    it("allows OpenAI audio transcription", () => {
      const result = checkUrl("https://api.openai.com/v1/audio/transcriptions");
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("ai_providers");
    });

    it("allows OpenAI responses endpoint", () => {
      const result = checkUrl("https://api.openai.com/v1/responses");
      expect(result.allowed).toBe(true);
    });

    it("allows OpenAI models endpoint", () => {
      const result = checkUrl("https://api.openai.com/v1/models");
      expect(result.allowed).toBe(true);
    });

    it("allows OpenAI chat completions", () => {
      const result = checkUrl(
        "https://api.openai.com/v1/chat/completions"
      );
      expect(result.allowed).toBe(true);
    });

    it("allows OpenAI realtime with query params", () => {
      const result = checkUrl(
        "https://api.openai.com/v1/realtime?intent=transcription"
      );
      expect(result.allowed).toBe(true);
    });

    it("allows Anthropic messages", () => {
      const result = checkUrl("https://api.anthropic.com/v1/messages");
      expect(result.allowed).toBe(true);
    });

    it("allows Gemini generateContent", () => {
      const result = checkUrl(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro/generateContent"
      );
      expect(result.allowed).toBe(true);
    });

    it("allows Groq audio endpoint", () => {
      const result = checkUrl(
        "https://api.groq.com/openai/v1/audio/transcriptions"
      );
      expect(result.allowed).toBe(true);
    });

    it("allows Deepgram listen", () => {
      const result = checkUrl("https://api.deepgram.com/v1/listen");
      expect(result.allowed).toBe(true);
    });
  });

  describe("allowed model download URLs", () => {
    it("allows HuggingFace model downloads", () => {
      const result = checkUrl(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("model_downloads");
    });

    it("allows GitHub release downloads", () => {
      const result = checkUrl(
        "https://github.com/nicholasgasior/whisper-cpp-builds/releases/download/v1.0/whisper-cpp-linux-x64.zip"
      );
      expect(result.allowed).toBe(true);
    });

    it("blocks GitHub API release queries due to domain precedence bug", () => {
      // api.github.com matches github.com (subdomain) first,
      // and github.com only allows /*/releases/download/* paths.
      // The api.github.com entry with /repos/*/releases* is never reached
      // because checkUrl returns early on first domain match + path mismatch.
      const result = checkUrl(
        "https://api.github.com/repos/nicholasgasior/whisper-cpp-builds/releases/latest"
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("path not allowed");
    });

    it("allows objects.githubusercontent.com", () => {
      const result = checkUrl(
        "https://objects.githubusercontent.com/github-production/release-asset/12345"
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("allowed local URLs", () => {
    it("allows localhost", () => {
      const result = checkUrl("http://localhost:5183/index.html");
      expect(result.allowed).toBe(true);
    });

    it("allows 127.0.0.1", () => {
      const result = checkUrl("http://127.0.0.1:8080/api/test");
      expect(result.allowed).toBe(true);
    });

    it("allows 0.0.0.0", () => {
      const result = checkUrl("http://0.0.0.0:3000/");
      expect(result.allowed).toBe(true);
    });
  });

  describe("blocked URLs", () => {
    it("blocks unknown domains", () => {
      const result = checkUrl("https://evil.example.com/steal-data");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("domain not in allowlist");
    });

    it("blocks tracking/analytics domains", () => {
      const result = checkUrl("https://www.google-analytics.com/collect");
      expect(result.allowed).toBe(false);
    });

    it("blocks social media", () => {
      const result = checkUrl("https://facebook.com/pixel");
      expect(result.allowed).toBe(false);
    });

    it("blocks telemetry endpoints", () => {
      const result = checkUrl("https://telemetry.someservice.com/v1/events");
      expect(result.allowed).toBe(false);
    });
  });

  describe("path enforcement", () => {
    it("blocks disallowed paths on allowed domains", () => {
      const result = checkUrl("https://api.openai.com/v2/something-new");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("path not allowed");
    });

    it("blocks Anthropic on non-messages paths", () => {
      const result = checkUrl("https://api.anthropic.com/v1/completions");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("path not allowed");
    });
  });

  describe("subdomain matching", () => {
    it("allows subdomains of allowed domains", () => {
      const result = checkUrl(
        "https://sub.objects.githubusercontent.com/some/asset"
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("invalid URLs", () => {
    it("blocks invalid URLs", () => {
      const result = checkUrl("not-a-url");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("invalid URL");
    });

    it("blocks empty string", () => {
      const result = checkUrl("");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("invalid URL");
    });
  });
});

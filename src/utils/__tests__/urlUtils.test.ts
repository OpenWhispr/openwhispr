import { describe, it, expect } from "vitest";
import { isSecureEndpoint } from "../urlUtils";

describe("isSecureEndpoint", () => {
  describe("HTTPS endpoints", () => {
    it("accepts https URLs", () => {
      expect(isSecureEndpoint("https://api.openai.com/v1")).toBe(true);
    });

    it("rejects plain http to public hosts", () => {
      expect(isSecureEndpoint("http://api.openai.com/v1")).toBe(false);
    });
  });

  describe("private/local hosts (allowed over http)", () => {
    it("allows localhost", () => {
      expect(isSecureEndpoint("http://localhost:8080")).toBe(true);
    });

    it("allows 127.0.0.1", () => {
      expect(isSecureEndpoint("http://127.0.0.1:5000")).toBe(true);
    });

    it("allows 127.x.x.x range", () => {
      expect(isSecureEndpoint("http://127.0.1.1:3000")).toBe(true);
    });

    it("allows 0.0.0.0", () => {
      expect(isSecureEndpoint("http://0.0.0.0:8000")).toBe(true);
    });

    it("allows 10.x.x.x private range", () => {
      expect(isSecureEndpoint("http://10.0.0.5:8080")).toBe(true);
    });

    it("allows 192.168.x.x private range", () => {
      expect(isSecureEndpoint("http://192.168.1.100:8080")).toBe(true);
    });

    it("allows 172.16-31.x.x private range", () => {
      expect(isSecureEndpoint("http://172.16.0.1:8080")).toBe(true);
      expect(isSecureEndpoint("http://172.31.255.255:8080")).toBe(true);
    });

    it("rejects 172.x outside 16-31 range", () => {
      expect(isSecureEndpoint("http://172.15.0.1:8080")).toBe(false);
      expect(isSecureEndpoint("http://172.32.0.1:8080")).toBe(false);
    });

    it("allows link-local 169.254.x.x", () => {
      expect(isSecureEndpoint("http://169.254.1.1:8080")).toBe(true);
    });

    it("allows IPv6 loopback ::1", () => {
      expect(isSecureEndpoint("http://[::1]:8080")).toBe(true);
    });

    it("allows IPv6 link-local fe80::", () => {
      expect(isSecureEndpoint("http://[fe80::1]:8080")).toBe(true);
    });

    it("allows IPv6 ULA fc/fd", () => {
      expect(isSecureEndpoint("http://[fc00::1]:8080")).toBe(true);
      expect(isSecureEndpoint("http://[fd12::1]:8080")).toBe(true);
    });

    it("allows .local hostnames", () => {
      expect(isSecureEndpoint("http://myserver.local:8080")).toBe(true);
    });
  });

  describe("invalid URLs", () => {
    it("returns false for empty string", () => {
      expect(isSecureEndpoint("")).toBe(false);
    });

    it("returns false for garbage input", () => {
      expect(isSecureEndpoint("not-a-url")).toBe(false);
    });
  });
});

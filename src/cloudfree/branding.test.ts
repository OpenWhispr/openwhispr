import { describe, it, expect } from "vitest";
import { BRANDING } from "./branding";

describe("BRANDING", () => {
  it("has correct top-level fields", () => {
    expect(BRANDING.name).toBe("CloudFree OpenWhispr");
    expect(BRANDING.shortName).toBe("CloudFree");
    expect(BRANDING.description).toContain("privacy-focused fork");
  });

  it("has upstream info", () => {
    expect(BRANDING.upstream.name).toBe("OpenWhispr");
    expect(BRANDING.upstream.url).toMatch(/^https:\/\//);
    expect(BRANDING.upstream.repo).toContain("github.com");
  });

  it("has fork repo links", () => {
    expect(BRANDING.fork.repo).toContain("cloudfree-openwhispr");
    expect(BRANDING.fork.issues).toContain("/issues");
  });

  it("has support info with valid URLs", () => {
    expect(BRANDING.support.bugReportUrl).toContain("/issues");
    expect(BRANDING.support.bugReportLabel).toBe("Report an Issue");
    expect(BRANDING.support.attribution).toBeTruthy();
    expect(BRANDING.support.disclaimer).toBeTruthy();
  });

  it("bug report URL matches fork issues URL", () => {
    expect(BRANDING.support.bugReportUrl).toBe(BRANDING.fork.issues);
  });
});

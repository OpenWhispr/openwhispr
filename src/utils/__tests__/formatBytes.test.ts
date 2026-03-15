import { describe, it, expect } from "vitest";
import { formatBytes } from "../formatBytes";

describe("formatBytes", () => {
  it("returns '0 Bytes' for zero", () => {
    expect(formatBytes(0)).toBe("0 Bytes");
  });

  it("formats bytes below 1 KB", () => {
    expect(formatBytes(500)).toBe("500 Bytes");
  });

  it("formats exact kilobyte boundary", () => {
    expect(formatBytes(1024)).toBe("1 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
  });

  it("formats terabytes", () => {
    expect(formatBytes(1024 ** 4)).toBe("1 TB");
  });

  it("formats fractional values with default 2 decimal places", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("respects custom decimal places", () => {
    expect(formatBytes(1536, 0)).toBe("2 KB");
    expect(formatBytes(1536, 1)).toBe("1.5 KB");
    expect(formatBytes(1536, 3)).toBe("1.5 KB");
  });

  it("treats negative decimals as 0", () => {
    expect(formatBytes(1536, -1)).toBe("2 KB");
  });

  it("formats large values correctly", () => {
    // 5.5 GB
    const bytes = 5.5 * 1024 * 1024 * 1024;
    expect(formatBytes(bytes)).toBe("5.5 GB");
  });

  it("handles 1 byte", () => {
    expect(formatBytes(1)).toBe("1 Bytes");
  });
});

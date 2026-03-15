import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SecureCache } from "../SecureCache";

describe("SecureCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves values", () => {
    const cache = new SecureCache<string>(60000);
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("returns undefined for missing keys", () => {
    const cache = new SecureCache<string>(60000);
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const cache = new SecureCache<string>(1000);
    cache.set("key1", "value1");

    expect(cache.get("key1")).toBe("value1");

    vi.advanceTimersByTime(1001);

    expect(cache.get("key1")).toBeUndefined();
  });

  it("returns value just before TTL expires", () => {
    const cache = new SecureCache<string>(1000);
    cache.set("key1", "value1");

    vi.advanceTimersByTime(999);

    expect(cache.get("key1")).toBe("value1");
  });

  it("has() returns false for expired entries", () => {
    const cache = new SecureCache<string>(1000);
    cache.set("key1", "value1");

    vi.advanceTimersByTime(1001);

    expect(cache.has("key1")).toBe(false);
  });

  it("has() returns true for live entries", () => {
    const cache = new SecureCache<string>(60000);
    cache.set("key1", "value1");
    expect(cache.has("key1")).toBe(true);
  });

  it("delete() removes entries", () => {
    const cache = new SecureCache<string>(60000);
    cache.set("key1", "value1");
    expect(cache.delete("key1")).toBe(true);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("delete() returns false for missing keys", () => {
    const cache = new SecureCache<string>(60000);
    expect(cache.delete("nonexistent")).toBe(false);
  });

  it("clear() removes all entries", () => {
    const cache = new SecureCache<string>(60000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("size reflects current entry count (including expired)", () => {
    const cache = new SecureCache<string>(1000);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);

    // Size includes expired entries until cleanup
    vi.advanceTimersByTime(1001);
    expect(cache.size).toBe(2);
  });

  it("cleanup() removes expired entries", () => {
    const cache = new SecureCache<string>(1000);
    cache.set("old", "1");

    vi.advanceTimersByTime(1001);

    cache.set("new", "2");
    cache.cleanup();

    expect(cache.size).toBe(1);
    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("new")).toBe("2");
  });

  it("startAutoCleanup runs periodic cleanup and returns stop fn", () => {
    const cache = new SecureCache<string>(500);
    cache.set("key1", "value1");

    const stop = cache.startAutoCleanup(1000);

    vi.advanceTimersByTime(600); // entry expired
    expect(cache.size).toBe(1); // not cleaned yet

    vi.advanceTimersByTime(500); // cleanup fires at 1000ms
    expect(cache.size).toBe(0);

    // Stop should prevent further cleanup
    cache.set("key2", "value2");
    stop();
    vi.advanceTimersByTime(2000);
    // Cache still has the entry because auto-cleanup was stopped
    // (it may be expired but still in map since no cleanup ran)
    expect(cache.size).toBe(1);
  });

  it("overwrites existing keys", () => {
    const cache = new SecureCache<string>(60000);
    cache.set("key1", "first");
    cache.set("key1", "second");
    expect(cache.get("key1")).toBe("second");
  });
});

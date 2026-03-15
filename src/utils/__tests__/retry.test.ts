import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, createApiRetryStrategy, createFileRetryStrategy } from "../retry";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, initialDelay: 100 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, initialDelay: 100, backoffMultiplier: 2 });

    // First retry delay: 100ms
    await vi.advanceTimersByTimeAsync(100);
    // Second retry delay: 200ms
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries", async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    await expect(
      withRetry(fn, { maxRetries: 2, initialDelay: 1, maxDelay: 1 })
    ).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    vi.useFakeTimers();
  });

  it("respects shouldRetry predicate", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("non-retryable"));

    const promise = withRetry(fn, {
      maxRetries: 3,
      initialDelay: 100,
      shouldRetry: () => false,
    });

    await expect(promise).rejects.toThrow("non-retryable");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("caps delay at maxDelay", async () => {
    let delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockRejectedValueOnce(new Error("3"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, {
      maxRetries: 3,
      initialDelay: 5000,
      maxDelay: 8000,
      backoffMultiplier: 2,
    });

    // First delay: 5000
    await vi.advanceTimersByTimeAsync(5000);
    // Second delay: min(10000, 8000) = 8000
    await vi.advanceTimersByTimeAsync(8000);
    // Third delay: min(16000, 8000) = 8000
    await vi.advanceTimersByTimeAsync(8000);

    const result = await promise;
    expect(result).toBe("ok");
  });
});

describe("createApiRetryStrategy", () => {
  it("retries on network errors (no response)", () => {
    const strategy = createApiRetryStrategy();
    expect(strategy.shouldRetry(new Error("ECONNREFUSED"))).toBe(true);
  });

  it("retries on 5xx status codes", () => {
    const strategy = createApiRetryStrategy();
    expect(strategy.shouldRetry({ response: { status: 500 } })).toBe(true);
    expect(strategy.shouldRetry({ response: { status: 503 } })).toBe(true);
  });

  it("does not retry on 4xx status codes", () => {
    const strategy = createApiRetryStrategy();
    expect(strategy.shouldRetry({ response: { status: 400 } })).toBe(false);
    expect(strategy.shouldRetry({ response: { status: 404 } })).toBe(false);
    expect(strategy.shouldRetry({ response: { status: 429 } })).toBe(false);
  });
});

describe("createFileRetryStrategy", () => {
  it("retries on EBUSY, ENOENT, EPERM, EAGAIN", () => {
    const strategy = createFileRetryStrategy();
    expect(strategy.shouldRetry({ code: "EBUSY" })).toBe(true);
    expect(strategy.shouldRetry({ code: "ENOENT" })).toBe(true);
    expect(strategy.shouldRetry({ code: "EPERM" })).toBe(true);
    expect(strategy.shouldRetry({ code: "EAGAIN" })).toBe(true);
  });

  it("does not retry on other error codes", () => {
    const strategy = createFileRetryStrategy();
    expect(strategy.shouldRetry({ code: "EACCES" })).toBe(false);
    expect(strategy.shouldRetry({ code: "EISDIR" })).toBe(false);
  });

  it("has maxRetries of 2 and initialDelay of 500", () => {
    const strategy = createFileRetryStrategy();
    expect(strategy.maxRetries).toBe(2);
    expect(strategy.initialDelay).toBe(500);
  });
});

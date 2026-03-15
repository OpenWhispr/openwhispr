import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeDbDate, formatDateGroup, formatUpcomingDateGroup } from "../dateFormatting";

describe("normalizeDbDate", () => {
  it("appends Z to non-UTC date strings", () => {
    const result = normalizeDbDate("2024-01-15 10:30:00");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toContain("2024-01-15");
  });

  it("leaves strings already ending with Z unchanged", () => {
    const result = normalizeDbDate("2024-01-15T10:30:00Z");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });
});

describe("formatDateGroup", () => {
  const mockT = (key: string) => {
    const map: Record<string, string> = {
      "controlPanel.history.dateGroups.today": "Today",
      "controlPanel.history.dateGroups.yesterday": "Yesterday",
    };
    return map[key] || key;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'Today' for today's date", () => {
    expect(formatDateGroup(new Date("2024-06-15T08:00:00Z"), mockT)).toBe("Today");
  });

  it("returns 'Yesterday' for yesterday's date", () => {
    expect(formatDateGroup(new Date("2024-06-14T20:00:00Z"), mockT)).toBe("Yesterday");
  });

  it("returns formatted date for older dates", () => {
    const result = formatDateGroup(new Date("2024-01-10T12:00:00Z"), mockT);
    // Should contain month and day at minimum
    expect(result).toBeTruthy();
    expect(result).not.toBe("Today");
    expect(result).not.toBe("Yesterday");
  });

  it("accepts string dates", () => {
    expect(formatDateGroup("2024-06-15T08:00:00Z", mockT)).toBe("Today");
  });
});

describe("formatUpcomingDateGroup", () => {
  const mockT = (key: string) => {
    const map: Record<string, string> = {
      "controlPanel.history.dateGroups.today": "Today",
      "upcoming.tomorrow": "Tomorrow",
    };
    return map[key] || key;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'Today' for today's date", () => {
    expect(formatUpcomingDateGroup(new Date("2024-06-15T08:00:00Z"), mockT)).toBe("Today");
  });

  it("returns 'Tomorrow' for tomorrow's date", () => {
    expect(formatUpcomingDateGroup(new Date("2024-06-16T08:00:00Z"), mockT)).toBe("Tomorrow");
  });

  it("returns formatted date for further future dates", () => {
    const result = formatUpcomingDateGroup(new Date("2024-06-20T12:00:00Z"), mockT);
    expect(result).not.toBe("Today");
    expect(result).not.toBe("Tomorrow");
    expect(result).toBeTruthy();
  });
});

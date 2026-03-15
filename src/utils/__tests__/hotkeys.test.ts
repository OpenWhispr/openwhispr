import { describe, it, expect, vi } from "vitest";
import {
  isGlobeLikeHotkey,
  formatHotkeyLabelForPlatform,
  parseHotkey,
  isCompoundHotkey,
  isValidHotkeyFormat,
} from "../hotkeys";

describe("isGlobeLikeHotkey", () => {
  it("returns true for GLOBE", () => {
    expect(isGlobeLikeHotkey("GLOBE")).toBe(true);
  });

  it("returns true for Fn", () => {
    expect(isGlobeLikeHotkey("Fn")).toBe(true);
  });

  it("returns false for other keys", () => {
    expect(isGlobeLikeHotkey("F1")).toBe(false);
    expect(isGlobeLikeHotkey("globe")).toBe(false);
    expect(isGlobeLikeHotkey("fn")).toBe(false);
    expect(isGlobeLikeHotkey("")).toBe(false);
  });
});

describe("formatHotkeyLabelForPlatform", () => {
  it("returns empty string for empty/null input", () => {
    expect(formatHotkeyLabelForPlatform("", "darwin")).toBe("");
    expect(formatHotkeyLabelForPlatform("  ", "darwin")).toBe("");
  });

  it("returns 'Globe/Fn' for globe-like hotkeys", () => {
    expect(formatHotkeyLabelForPlatform("GLOBE", "darwin")).toBe("Globe/Fn");
    expect(formatHotkeyLabelForPlatform("Fn", "win32")).toBe("Globe/Fn");
  });

  describe("macOS formatting", () => {
    it("formats CommandOrControl as Cmd", () => {
      expect(formatHotkeyLabelForPlatform("CommandOrControl+K", "darwin")).toBe("Cmd+K");
    });

    it("formats Alt as Option", () => {
      expect(formatHotkeyLabelForPlatform("Alt+R", "darwin")).toBe("Option+R");
    });

    it("formats Super/Meta as Cmd", () => {
      expect(formatHotkeyLabelForPlatform("Super+K", "darwin")).toBe("Cmd+K");
      expect(formatHotkeyLabelForPlatform("Meta+K", "darwin")).toBe("Cmd+K");
    });
  });

  describe("Windows formatting", () => {
    it("formats CommandOrControl as Ctrl", () => {
      expect(formatHotkeyLabelForPlatform("CommandOrControl+K", "win32")).toBe("Ctrl+K");
    });

    it("keeps Alt as Alt", () => {
      expect(formatHotkeyLabelForPlatform("Alt+R", "win32")).toBe("Alt+R");
    });

    it("formats Super/Meta as Win", () => {
      expect(formatHotkeyLabelForPlatform("Super+K", "win32")).toBe("Win+K");
      expect(formatHotkeyLabelForPlatform("Meta+K", "win32")).toBe("Win+K");
    });
  });

  describe("Linux formatting", () => {
    it("formats Super as Super", () => {
      expect(formatHotkeyLabelForPlatform("Super+K", "linux")).toBe("Super+K");
    });

    it("formats Meta as Super", () => {
      expect(formatHotkeyLabelForPlatform("Meta+K", "linux")).toBe("Super+K");
    });
  });

  describe("right-side modifiers", () => {
    it("formats RightOption on macOS", () => {
      expect(formatHotkeyLabelForPlatform("RightOption", "darwin")).toBe("Right Option");
    });

    it("formats RightOption on Windows as Right Alt", () => {
      expect(formatHotkeyLabelForPlatform("RightOption", "win32")).toBe("Right Alt");
    });

    it("formats RightSuper on Windows as Right Win", () => {
      expect(formatHotkeyLabelForPlatform("RightSuper", "win32")).toBe("Right Win");
    });

    it("formats RightCommand as Right Cmd", () => {
      expect(formatHotkeyLabelForPlatform("RightCommand", "darwin")).toBe("Right Cmd");
    });
  });

  it("returns single keys as-is", () => {
    expect(formatHotkeyLabelForPlatform("`", "darwin")).toBe("`");
    expect(formatHotkeyLabelForPlatform("F8", "win32")).toBe("F8");
  });
});

describe("parseHotkey", () => {
  it("parses compound hotkey into modifiers and base key", () => {
    const result = parseHotkey("CommandOrControl+Shift+K");
    expect(result).toEqual({
      modifiers: ["CommandOrControl", "Shift"],
      baseKey: "K",
    });
  });

  it("returns empty modifiers for single key", () => {
    expect(parseHotkey("F8")).toEqual({ modifiers: [], baseKey: "F8" });
  });

  it("returns empty modifiers and key for empty string", () => {
    expect(parseHotkey("")).toEqual({ modifiers: [], baseKey: "" });
  });

  it("handles null/undefined", () => {
    // @ts-expect-error testing runtime safety
    expect(parseHotkey(null)).toEqual({ modifiers: [], baseKey: "" });
  });

  it("parses two-key combo", () => {
    expect(parseHotkey("Alt+R")).toEqual({ modifiers: ["Alt"], baseKey: "R" });
  });
});

describe("isCompoundHotkey", () => {
  it("returns true for compound hotkeys", () => {
    expect(isCompoundHotkey("Ctrl+Shift+K")).toBe(true);
    expect(isCompoundHotkey("Alt+R")).toBe(true);
  });

  it("returns false for single keys", () => {
    expect(isCompoundHotkey("F8")).toBe(false);
    expect(isCompoundHotkey("GLOBE")).toBe(false);
  });

  it("returns false for empty/null", () => {
    expect(isCompoundHotkey("")).toBe(false);
    // @ts-expect-error testing runtime safety
    expect(isCompoundHotkey(null)).toBe(false);
  });
});

describe("isValidHotkeyFormat", () => {
  it("accepts globe-like keys", () => {
    expect(isValidHotkeyFormat("GLOBE")).toBe(true);
    expect(isValidHotkeyFormat("Fn")).toBe(true);
  });

  it("accepts single character keys", () => {
    expect(isValidHotkeyFormat("`")).toBe(true);
    expect(isValidHotkeyFormat("A")).toBe(true);
  });

  it("accepts compound hotkeys", () => {
    expect(isValidHotkeyFormat("Ctrl+K")).toBe(true);
    expect(isValidHotkeyFormat("Alt+Shift+F9")).toBe(true);
  });

  it("rejects empty/whitespace", () => {
    expect(isValidHotkeyFormat("")).toBe(false);
    expect(isValidHotkeyFormat("  ")).toBe(false);
  });

  it("rejects hotkeys with empty parts (trailing +)", () => {
    expect(isValidHotkeyFormat("Ctrl+")).toBe(false);
    expect(isValidHotkeyFormat("+K")).toBe(false);
  });
});

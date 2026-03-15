import { describe, it, expect } from "vitest";
import { validateHotkey, normalizeHotkey, type Platform } from "../hotkeyValidator";

describe("normalizeHotkey", () => {
  it("returns empty string for empty input", () => {
    expect(normalizeHotkey("", "darwin")).toBe("");
  });

  it("normalizes CommandOrControl to Command on macOS", () => {
    expect(normalizeHotkey("CommandOrControl+K", "darwin")).toBe("Command+K");
  });

  it("normalizes CommandOrControl to Control on Windows", () => {
    expect(normalizeHotkey("CommandOrControl+K", "win32")).toBe("Control+K");
  });

  it("normalizes CmdOrCtrl alias", () => {
    expect(normalizeHotkey("CmdOrCtrl+K", "darwin")).toBe("Command+K");
    expect(normalizeHotkey("CmdOrCtrl+K", "win32")).toBe("Control+K");
  });

  it("normalizes Alt/Option to Alt", () => {
    expect(normalizeHotkey("Option+R", "darwin")).toBe("Alt+R");
  });

  it("normalizes Super/Win/Meta to platform-appropriate modifier", () => {
    expect(normalizeHotkey("Super+K", "darwin")).toBe("Command+K");
    expect(normalizeHotkey("Win+K", "win32")).toBe("Super+K");
    expect(normalizeHotkey("Meta+K", "linux")).toBe("Super+K");
  });

  it("sorts modifiers in canonical order", () => {
    // MODIFIER_ORDER = Control, Command, Alt, Shift, Super, Fn
    expect(normalizeHotkey("Shift+Control+K", "win32")).toBe("Control+Shift+K");
    expect(normalizeHotkey("Shift+Alt+Control+K", "win32")).toBe("Control+Alt+Shift+K");
  });

  it("normalizes key tokens", () => {
    expect(normalizeHotkey("Ctrl+ArrowLeft", "win32")).toBe("Control+Left");
    expect(normalizeHotkey("Ctrl+Escape", "win32")).toBe("Control+Esc");
    expect(normalizeHotkey("Ctrl+pgup", "win32")).toBe("Control+PageUp");
  });

  it("normalizes single-character keys to uppercase", () => {
    expect(normalizeHotkey("Ctrl+k", "win32")).toBe("Control+K");
  });

  it("normalizes function keys", () => {
    expect(normalizeHotkey("Ctrl+f9", "win32")).toBe("Control+F9");
  });
});

describe("validateHotkey", () => {
  it("rejects empty/whitespace", () => {
    expect(validateHotkey("", "darwin").valid).toBe(false);
    expect(validateHotkey("  ", "darwin").valid).toBe(false);
  });

  it("accepts GLOBE/Fn only on macOS", () => {
    expect(validateHotkey("GLOBE", "darwin").valid).toBe(true);
    expect(validateHotkey("Fn", "darwin").valid).toBe(true);
    const win = validateHotkey("GLOBE", "win32");
    expect(win.valid).toBe(false);
    expect(win.errorCode).toBe("INVALID_GLOBE");
  });

  it("rejects shortcuts with more than 3 keys", () => {
    const result = validateHotkey("Ctrl+Alt+Shift+K", "win32");
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("TOO_MANY_KEYS");
  });

  it("requires a modifier or special key", () => {
    const result = validateHotkey("K", "win32");
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("NO_MODIFIER_OR_SPECIAL");
  });

  it("accepts standalone special keys (function keys, etc.)", () => {
    expect(validateHotkey("F8", "darwin").valid).toBe(true);
    expect(validateHotkey("Space", "win32").valid).toBe(true);
    expect(validateHotkey("Esc", "linux").valid).toBe(true);
  });

  it("rejects left-right modifier mixing", () => {
    const result = validateHotkey("LeftCtrl+RightCtrl+K", "win32");
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("LEFT_RIGHT_MIX");
  });

  it("rejects single left-side modifier as hotkey", () => {
    const result = validateHotkey("Control", "win32");
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("LEFT_MODIFIER_ONLY");
  });

  it("accepts single right-side modifier on macOS/Windows", () => {
    expect(validateHotkey("RightOption", "darwin").valid).toBe(true);
    expect(validateHotkey("RightAlt", "win32").valid).toBe(true);
  });

  it("rejects single right-side modifier on Linux", () => {
    const result = validateHotkey("RightAlt", "linux");
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("LEFT_MODIFIER_ONLY");
  });

  it("accepts two-modifier combos (no base key)", () => {
    expect(validateHotkey("Control+Alt", "win32").valid).toBe(true);
    expect(validateHotkey("Control+Super", "linux").valid).toBe(true);
  });

  it("detects duplicates against existing hotkeys", () => {
    const result = validateHotkey("Ctrl+K", "win32", ["Control+K"]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("DUPLICATE");
  });

  describe("reserved shortcuts", () => {
    it("rejects Cmd+C on macOS", () => {
      const result = validateHotkey("Command+C", "darwin");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("RESERVED");
    });

    it("rejects Ctrl+C on Windows", () => {
      const result = validateHotkey("Control+C", "win32");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("RESERVED");
    });

    it("rejects Ctrl+C on Linux", () => {
      const result = validateHotkey("Control+C", "linux");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("RESERVED");
    });

    it("rejects Alt+Tab on Windows", () => {
      const result = validateHotkey("Alt+Tab", "win32");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("RESERVED");
    });

    it("rejects Alt+F4 on Windows", () => {
      const result = validateHotkey("Alt+F4", "win32");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("RESERVED");
    });

    it("rejects Ctrl+Alt+Delete on Linux", () => {
      const result = validateHotkey("Control+Alt+Delete", "linux");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe("RESERVED");
    });
  });

  it("accepts valid compound shortcuts", () => {
    expect(validateHotkey("Control+Shift+K", "darwin").valid).toBe(true);
    expect(validateHotkey("Alt+F7", "win32").valid).toBe(true);
    expect(validateHotkey("Control+Super+K", "linux").valid).toBe(true);
  });
});

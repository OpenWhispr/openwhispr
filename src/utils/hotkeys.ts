/**
 * Hotkey utilities for formatting and displaying keyboard shortcuts.
 * Supports both single keys and compound hotkeys (e.g., "CommandOrControl+Shift+K").
 */

import { getPlatform, type Platform } from "./platform";

export function isGlobeLikeHotkey(hotkey: string): boolean {
  return hotkey === "GLOBE" || hotkey === "Fn";
}

export function isMouseButtonHotkey(hotkey: string): boolean {
  return /^MouseButton[45]$/i.test(hotkey || "");
}

function formatModifierPart(part: string, platform: Platform): string {
  switch (part) {
    case "CommandOrControl":
      return platform === "darwin" ? "Cmd" : "Ctrl";
    case "Command":
    case "Cmd":
      return "Cmd";
    case "Control":
    case "Ctrl":
      return "Ctrl";
    case "Alt":
      return platform === "darwin" ? "Option" : "Alt";
    case "Option":
      return "Option";
    case "Shift":
      return "Shift";
    case "Super":
    case "Meta":
      return platform === "darwin" ? "Cmd" : platform === "win32" ? "Win" : "Super";
    case "Win":
      return platform === "win32" ? "Win" : "Super";
    case "Fn":
      return "Fn";
    default:
      return part;
  }
}

/**
 * Formats an Electron accelerator string into a user-friendly display label.
 *
 * @param hotkey - The hotkey string in Electron accelerator format
 * @returns User-friendly label (e.g., "Cmd+Shift+K" on macOS, "Ctrl+Shift+K" on Windows)
 *
 * @example
 * formatHotkeyLabel("CommandOrControl+Shift+K") // "Cmd+Shift+K" on macOS, "Ctrl+Shift+K" on Windows
 * formatHotkeyLabel("GLOBE") // "Globe"
 * formatHotkeyLabel("`") // "`"
 * formatHotkeyLabel(null) // platform default
 */
export function formatHotkeyLabel(hotkey?: string | null): string {
  const platform = getPlatform();
  const resolvedHotkey = hotkey && hotkey.trim() !== "" ? hotkey : getDefaultHotkey();
  return formatHotkeyLabelForPlatform(resolvedHotkey, platform);
}

export function formatHotkeyLabelForPlatform(hotkey: string, platform: Platform): string {
  if (!hotkey || hotkey.trim() === "") {
    return "";
  }

  if (isGlobeLikeHotkey(hotkey)) {
    return "Globe/Fn";
  }

  if (isMouseButtonHotkey(hotkey)) {
    return hotkey === "MouseButton4" ? "Mouse Button 4" : "Mouse Button 5";
  }

  // Right-side single modifiers
  const rightSideMap: Record<string, string> = {
    RightOption: platform === "darwin" ? "Right Option" : "Right Alt",
    RightAlt: "Right Alt",
    RightCommand: "Right Cmd",
    RightCmd: "Right Cmd",
    RightControl: "Right Ctrl",
    RightCtrl: "Right Ctrl",
    RightShift: "Right Shift",
    RightSuper: platform === "win32" ? "Right Win" : "Right Super",
    RightMeta:
      platform === "darwin" ? "Right Cmd" : platform === "win32" ? "Right Win" : "Right Super",
    RightWin: "Right Win",
  };
  if (rightSideMap[hotkey]) {
    return rightSideMap[hotkey];
  }

  if (hotkey.includes("+")) {
    const parts = hotkey.split("+");
    const formattedParts = parts.map((part) => formatModifierPart(part, platform));
    return formattedParts.join("+");
  }

  return hotkey;
}

/**
 * Parses a hotkey string to extract modifiers and the base key.
 *
 * @param hotkey - The hotkey string in Electron accelerator format
 * @returns Object with modifiers array and baseKey
 *
 * @example
 * parseHotkey("CommandOrControl+Shift+K")
 * // { modifiers: ["CommandOrControl", "Shift"], baseKey: "K" }
 */
export function parseHotkey(hotkey: string): {
  modifiers: string[];
  baseKey: string;
} {
  if (!hotkey || !hotkey.includes("+")) {
    return { modifiers: [], baseKey: hotkey || "" };
  }

  const parts = hotkey.split("+");
  const baseKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  return { modifiers, baseKey };
}

/**
 * Checks if a hotkey is a compound hotkey (has modifiers).
 *
 * @param hotkey - The hotkey string
 * @returns True if the hotkey includes modifiers
 */
export function isCompoundHotkey(hotkey: string): boolean {
  return hotkey?.includes("+") || false;
}

/**
 * Gets the default hotkey for the current platform.
 * - macOS: GLOBE key (Fn key on modern Macs)
 * - Windows/Linux: Control+Super (Ctrl+Win / Ctrl+Super)
 */
export function getDefaultHotkey(): string {
  const platform = getPlatform();
  return platform === "darwin" ? "GLOBE" : "Control+Super";
}

/**
 * Validates if a hotkey string is in a valid format.
 * Valid formats include single keys and Electron accelerator strings.
 *
 * @param hotkey - The hotkey string to validate
 * @returns True if the hotkey format is valid
 */
export function isValidHotkeyFormat(hotkey: string): boolean {
  if (!hotkey || hotkey.trim() === "") {
    return false;
  }

  if (isGlobeLikeHotkey(hotkey) || isMouseButtonHotkey(hotkey)) {
    return true;
  }

  // Single character or word keys are valid
  if (!hotkey.includes("+")) {
    return true;
  }

  // Compound hotkey: must have at least one modifier and one base key
  const parts = hotkey.split("+");
  if (parts.length < 2) {
    return false;
  }

  // Check that all parts are non-empty
  return parts.every((part) => part.trim().length > 0);
}

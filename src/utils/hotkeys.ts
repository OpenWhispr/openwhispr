/**
 * Hotkey utilities for formatting and displaying keyboard shortcuts.
 * Supports both single keys and compound hotkeys (e.g., "CommandOrControl+Shift+K").
 */

import { getPlatform, type Platform } from "./platform.ts";

export function isGlobeLikeHotkey(hotkey: string): boolean {
  return hotkey === "GLOBE" || hotkey === "Fn";
}

/**
 * Parse a comma-separated hotkey list (a legacy single value is a one-item
 * list): trimmed, de-duplicated, empties removed, order preserved. The comma
 * KEY is itself a valid hotkey (e.g. "Control+,"): no accelerator legitimately
 * ends with "+", so a split segment ending in "+" gets its comma restored.
 *
 * Keep in sync with the main-process twin in src/helpers/hotkeyList.js.
 */
export function parseHotkeyList(value?: string | null): string[] {
  if (!value) return [];
  const raw = value.split(",");
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let hotkey = raw[i].trim();
    if (hotkey.endsWith("+") && i < raw.length - 1 && raw[i + 1].trim() === "") {
      hotkey += ",";
    }
    if (!hotkey || seen.has(hotkey)) continue;
    seen.add(hotkey);
    result.push(hotkey);
  }
  return result;
}

/** Serialize a hotkey list back to the canonical comma-separated string. */
export function serializeHotkeyList(list: string[]): string {
  return parseHotkeyList(list.join(",")).join(",");
}

export function isMouseButtonHotkey(hotkey: string): boolean {
  return /^MouseButton[45]$/i.test(hotkey || "");
}

/**
 * Display label for a side-qualified modifier token ("RightOption" →
 * "Right Option", "LeftControl" → "Left Ctrl"), or null when the token carries
 * no side.
 */
function formatSideModifierPart(part: string, platform: Platform): string | null {
  const match = /^(Right|Left)(Option|Alt|Command|Cmd|Control|Ctrl|Shift|Super|Meta|Win)$/.exec(
    part
  );
  if (!match) return null;
  const [, side, key] = match;
  return `${side} ${formatModifierPart(key === "Option" ? "Alt" : key, platform)}`;
}

/**
 * Side-qualified token for a modifier `KeyboardEvent.code`, matching the tokens
 * {@link formatSideModifierPart} and the hotkey validator understand
 * ("AltRight" → "RightOption" on macOS, "RightAlt" elsewhere). Null for codes
 * that carry no side, such as "CapsLock".
 */
export function sidedModifierToken(code: string, platform: Platform): string | null {
  const match = /^(Control|Alt|Shift|Meta)(Left|Right)$/.exec(code);
  if (!match) return null;
  const [, key, side] = match;
  switch (key) {
    case "Control":
      return `${side}Control`;
    case "Shift":
      return `${side}Shift`;
    case "Alt":
      return platform === "darwin" ? `${side}Option` : `${side}Alt`;
    default:
      return platform === "darwin" ? `${side}Command` : `${side}Super`;
  }
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

/**
 * Label for a comma-separated hotkey list: entries formatted individually and
 * joined with " / "; empty lists fall back like formatHotkeyLabel.
 */
export function formatHotkeyListLabel(value?: string | null): string {
  const list = parseHotkeyList(value);
  if (list.length === 0) return formatHotkeyLabel(value);
  return list.map((hotkey) => formatHotkeyLabel(hotkey)).join(" / ");
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

  if (hotkey.includes("+")) {
    const parts = hotkey.split("+");
    const formattedParts = parts.map(
      (part) => formatSideModifierPart(part, platform) ?? formatModifierPart(part, platform)
    );
    return formattedParts.join("+");
  }

  return formatSideModifierPart(hotkey, platform) ?? formatModifierPart(hotkey, platform);
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

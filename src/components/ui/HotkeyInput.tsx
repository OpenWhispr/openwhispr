import React, { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { getPlatform } from "../../utils/platform";

const CODE_TO_KEY: Record<string, string> = {
  Backquote: "`",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Digit0: "0",
  Minus: "-",
  Equal: "=",
  // QWERTY row
  KeyQ: "Q",
  KeyW: "W",
  KeyE: "E",
  KeyR: "R",
  KeyT: "T",
  KeyY: "Y",
  KeyU: "U",
  KeyI: "I",
  KeyO: "O",
  KeyP: "P",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  // ASDF row
  KeyA: "A",
  KeyS: "S",
  KeyD: "D",
  KeyF: "F",
  KeyG: "G",
  KeyH: "H",
  KeyJ: "J",
  KeyK: "K",
  KeyL: "L",
  Semicolon: ";",
  Quote: "'",
  // ZXCV row
  KeyZ: "Z",
  KeyX: "X",
  KeyC: "C",
  KeyV: "V",
  KeyB: "B",
  KeyN: "N",
  KeyM: "M",
  Comma: ",",
  Period: ".",
  Slash: "/",
  // Special keys
  Space: "Space",
  Escape: "Esc",
  Tab: "Tab",
  Enter: "Enter",
  Backspace: "Backspace",
  // Function keys
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
  // Extended function keys (F13-F24)
  F13: "F13",
  F14: "F14",
  F15: "F15",
  F16: "F16",
  F17: "F17",
  F18: "F18",
  F19: "F19",
  F20: "F20",
  F21: "F21",
  F22: "F22",
  F23: "F23",
  F24: "F24",
  // Arrow keys
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  // Navigation keys
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  // Additional keys (useful on Windows/Linux)
  Pause: "Pause",
  ScrollLock: "Scrolllock",
  PrintScreen: "PrintScreen",
  NumLock: "Numlock",
  // Numpad keys
  Numpad0: "num0",
  Numpad1: "num1",
  Numpad2: "num2",
  Numpad3: "num3",
  Numpad4: "num4",
  Numpad5: "num5",
  Numpad6: "num6",
  Numpad7: "num7",
  Numpad8: "num8",
  Numpad9: "num9",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
  NumpadEnter: "Enter",
  // Media keys (may work on some systems)
  MediaPlayPause: "MediaPlayPause",
  MediaStop: "MediaStop",
  MediaTrackNext: "MediaNextTrack",
  MediaTrackPrevious: "MediaPreviousTrack",
};

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
]);

export interface HotkeyInputProps {
  value: string;
  onChange: (hotkey: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  validate?: (hotkey: string) => string | null | undefined;
}

export function mapKeyboardEventToHotkey(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) {
    return null;
  }

  const baseKey = CODE_TO_KEY[e.code];
  if (!baseKey) {
    return null;
  }

  const platform = getPlatform();
  const modifiers: string[] = [];

  if (platform === "darwin") {
    if (e.ctrlKey) modifiers.push("Control");
    if (e.metaKey) modifiers.push("Command");
  } else {
    if (e.ctrlKey) modifiers.push("Control");
    if (e.metaKey) modifiers.push("Super");
  }

  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");

  return modifiers.length > 0 ? [...modifiers, baseKey].join("+") : baseKey;
}

export interface HotkeyInputVariant {
  variant?: "default" | "hero";
}

export function HotkeyInput({
  value,
  onChange,
  onBlur,
  disabled = false,
  autoFocus = false,
  variant = "default",
  validate,
}: HotkeyInputProps & HotkeyInputVariant) {
  const { t } = useTranslation();
  const [isCapturing, setIsCapturing] = useState(false);
  const [activeModifiers, setActiveModifiers] = useState<Set<string>>(new Set());
  const [validationWarning, setValidationWarning] = useState<string | null>(null);
  const [isFnHeld, setIsFnHeld] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastCapturedHotkeyRef = useRef<string | null>(null);
  const keyDownTimeRef = useRef<number>(0);
  const warningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnHeldRef = useRef(false);
  const fnCapturedKeyRef = useRef(false);
  const heldModifiersRef = useRef<{
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
    shift: boolean;
  }>({ ctrl: false, meta: false, alt: false, shift: false });
  const modifierCodesRef = useRef<{
    ctrl?: string;
    meta?: string;
    alt?: string;
    shift?: string;
  }>({});
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWindows = platform === "win32";

  const MODIFIER_HOLD_THRESHOLD_MS = 200;

  const buildModifierOnlyHotkey = useCallback(
    (
      modifiers: { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean },
      codes: { ctrl?: string; meta?: string; alt?: string; shift?: string }
    ): string | null => {
      // Check for right-side single modifier first
      const rightSidePressed: string[] = [];
      if (codes.ctrl === "ControlRight") rightSidePressed.push("RightControl");
      if (codes.meta === "MetaRight") rightSidePressed.push(isMac ? "RightCommand" : "RightSuper");
      if (codes.alt === "AltRight") rightSidePressed.push(isMac ? "RightOption" : "RightAlt");
      if (codes.shift === "ShiftRight") rightSidePressed.push("RightShift");

      // If exactly one right-side modifier, allow it as single-key hotkey
      if (rightSidePressed.length === 1) {
        const activeCount = [modifiers.ctrl, modifiers.meta, modifiers.alt, modifiers.shift].filter(
          Boolean
        ).length;
        if (activeCount === 1) {
          return rightSidePressed[0];
        }
      }

      // Otherwise require 2+ modifiers (existing logic)
      const parts: string[] = [];
      if (modifiers.ctrl) parts.push("Control");
      if (modifiers.meta) parts.push(isMac ? "Command" : "Super");
      if (modifiers.alt) parts.push("Alt");
      if (modifiers.shift) parts.push("Shift");

      if (parts.length >= 2) {
        return parts.join("+");
      }
      return null;
    },
    [isMac]
  );

  const clearFnHeld = useCallback(() => {
    setIsFnHeld(false);
    fnHeldRef.current = false;
    fnCapturedKeyRef.current = false;
  }, []);

  const finalizeCapture = useCallback(
    (hotkey: string) => {
      if (warningTimeoutRef.current) {
        clearTimeout(warningTimeoutRef.current);
        warningTimeoutRef.current = null;
      }

      if (validate) {
        const errorMsg = validate(hotkey);
        if (errorMsg) {
          setValidationWarning(errorMsg);
          warningTimeoutRef.current = setTimeout(() => setValidationWarning(null), 4000);
          heldModifiersRef.current = { ctrl: false, meta: false, alt: false, shift: false };
          modifierCodesRef.current = {};
          setActiveModifiers(new Set());
          keyDownTimeRef.current = 0;
          clearFnHeld();
          return;
        }
      }

      setValidationWarning(null);
      lastCapturedHotkeyRef.current = hotkey;
      onChange(hotkey);
      setIsCapturing(false);
      setActiveModifiers(new Set());
      clearFnHeld();
      containerRef.current?.blur();
    },
    [validate, onChange, clearFnHeld]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();

      // Track held modifiers for modifier-only capture
      heldModifiersRef.current = {
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
      };

      // Track which specific keys are pressed (for left/right detection)
      const code = e.nativeEvent.code;
      if (code === "ControlLeft" || code === "ControlRight") {
        modifierCodesRef.current.ctrl = code;
      } else if (code === "MetaLeft" || code === "MetaRight") {
        modifierCodesRef.current.meta = code;
      } else if (code === "AltLeft" || code === "AltRight") {
        modifierCodesRef.current.alt = code;
      } else if (code === "ShiftLeft" || code === "ShiftRight") {
        modifierCodesRef.current.shift = code;
      }

      // Track when first pressed (for hold detection)
      if (keyDownTimeRef.current === 0) {
        keyDownTimeRef.current = Date.now();
      }

      const mods = new Set<string>();
      if (isMac) {
        if (e.metaKey) mods.add("Cmd");
        if (e.ctrlKey) mods.add("Ctrl");
      } else {
        if (e.ctrlKey) mods.add("Ctrl");
        if (e.metaKey) mods.add(isWindows ? "Win" : "Super");
      }
      if (e.altKey) mods.add(isMac ? "Option" : "Alt");
      if (e.shiftKey) mods.add("Shift");
      if (fnHeldRef.current) mods.add("Fn");
      setActiveModifiers(mods);

      // Try to get non-modifier hotkey first
      const hotkey = mapKeyboardEventToHotkey(e.nativeEvent);
      if (hotkey) {
        keyDownTimeRef.current = 0;
        if (fnHeldRef.current) {
          fnCapturedKeyRef.current = true;
          finalizeCapture(`Fn+${hotkey}`);
        } else {
          finalizeCapture(hotkey);
        }
      }
      // If no base key, modifiers are held - don't finalize yet
    },
    [disabled, isMac, isWindows, finalizeCapture]
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();

      const wasHoldingModifiers =
        heldModifiersRef.current.ctrl ||
        heldModifiersRef.current.meta ||
        heldModifiersRef.current.alt ||
        heldModifiersRef.current.shift;

      let attempted = false;

      if (wasHoldingModifiers && MODIFIER_CODES.has(e.nativeEvent.code)) {
        const holdDuration = Date.now() - keyDownTimeRef.current;

        if (holdDuration >= MODIFIER_HOLD_THRESHOLD_MS) {
          const modifierHotkey = buildModifierOnlyHotkey(
            heldModifiersRef.current,
            modifierCodesRef.current
          );
          if (modifierHotkey) {
            attempted = true;
            if (fnHeldRef.current) {
              fnCapturedKeyRef.current = true;
              finalizeCapture(`Fn+${modifierHotkey}`);
            } else {
              finalizeCapture(modifierHotkey);
            }
          }
        }
      }

      if (!attempted) {
        heldModifiersRef.current = { ctrl: false, meta: false, alt: false, shift: false };
        modifierCodesRef.current = {};
        setActiveModifiers(fnHeldRef.current ? new Set(["Fn"]) : new Set());
        keyDownTimeRef.current = 0;
      }
    },
    [disabled, buildModifierOnlyHotkey, finalizeCapture]
  );

  const handleFocus = useCallback(() => {
    if (!disabled) {
      setIsCapturing(true);
      setValidationWarning(null);
      clearFnHeld();
      window.electronAPI?.setHotkeyListeningMode?.(true);
    }
  }, [disabled, clearFnHeld]);

  const handleBlur = useCallback(() => {
    setIsCapturing(false);
    setActiveModifiers(new Set());
    setValidationWarning(null);
    clearFnHeld();
    window.electronAPI?.setHotkeyListeningMode?.(false, lastCapturedHotkeyRef.current);
    lastCapturedHotkeyRef.current = null;
    onBlur?.();
  }, [onBlur, clearFnHeld]);

  useEffect(() => {
    if (autoFocus && containerRef.current) {
      containerRef.current.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    return () => {
      window.electronAPI?.setHotkeyListeningMode?.(false, null);
      if (warningTimeoutRef.current) clearTimeout(warningTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isCapturing || !isMac) return;

    const disposeDown = window.electronAPI?.onGlobeKeyPressed?.(() => {
      setValidationWarning(null);
      setIsFnHeld(true);
      fnHeldRef.current = true;
      fnCapturedKeyRef.current = false;
      setActiveModifiers((prev) => new Set([...prev, "Fn"]));
    });

    const disposeUp = window.electronAPI?.onGlobeKeyReleased?.(() => {
      if (fnHeldRef.current && !fnCapturedKeyRef.current) {
        finalizeCapture("GLOBE");
      }
      setIsFnHeld(false);
      fnHeldRef.current = false;
      fnCapturedKeyRef.current = false;
    });

    return () => {
      disposeDown?.();
      disposeUp?.();
    };
  }, [isCapturing, isMac, finalizeCapture]);

  const displayValue = formatHotkeyLabel(value);
  const isGlobe = value === "GLOBE";
  const hotkeyParts = value?.includes("+") ? displayValue.split("+") : [];

  // Hero variant: large centered key display for onboarding
  if (variant === "hero") {
    return (
      <div
        ref={containerRef}
        tabIndex={disabled ? -1 : 0}
        role="button"
        aria-label={t("hotkeyInput.ariaLabel")}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={`
          relative group flex flex-col items-center justify-center py-4 px-5 min-h-28
          rounded-md border cursor-pointer select-none outline-none
          transition-colors duration-150
          ${
            disabled
              ? "bg-muted/30 border-border cursor-not-allowed opacity-50"
              : isCapturing
                ? "bg-primary/5 border-primary/30 shadow-[0_0_0_2px_rgba(37,99,212,0.1)]"
                : "bg-surface-1 border-border hover:border-border-hover hover:bg-surface-2"
          }
        `}
      >
        {/* Recording state */}
        {isCapturing ? (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
              <span className="text-xs font-medium text-primary">{t("hotkeyInput.listening")}</span>
            </div>
            {activeModifiers.size > 0 ? (
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex items-center gap-1.5">
                  {Array.from(activeModifiers).map((mod) => (
                    <kbd
                      key={mod}
                      className="px-2.5 py-1 bg-primary/10 border border-primary/20 rounded-sm text-xs font-semibold text-primary"
                    >
                      {mod}
                    </kbd>
                  ))}
                  <span className="text-primary/50 text-sm font-medium">+</span>
                </div>
                {isFnHeld && (
                  <span className="text-xs text-muted-foreground">
                    {t("hotkeyInput.fnHeldHint")}
                  </span>
                )}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                {isMac ? t("hotkeyInput.pressAnyKeyMac") : t("hotkeyInput.pressAnyKey")}
              </span>
            )}
            {validationWarning && (
              <div className="flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-md bg-warning/8 border border-warning/20 dark:bg-warning/12 dark:border-warning/25">
                <AlertTriangle className="w-3 h-3 text-warning shrink-0" />
                <span className="text-xs text-warning dark:text-amber-400">
                  {validationWarning}
                </span>
              </div>
            )}
          </div>
        ) : value ? (
          /* Has value: show the hotkey prominently */
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-1.5">
              {hotkeyParts.length > 0 ? (
                hotkeyParts.map((part, i) => (
                  <React.Fragment key={part}>
                    {i > 0 && (
                      <span className="text-muted-foreground/40 text-lg font-light">+</span>
                    )}
                    <kbd className="px-3 py-1.5 bg-surface-raised border border-border rounded-sm text-sm font-semibold text-foreground shadow-sm">
                      {part}
                    </kbd>
                  </React.Fragment>
                ))
              ) : isGlobe ? (
                <kbd className="px-3 py-1.5 bg-surface-raised border border-border rounded-sm text-lg shadow-sm">
                  🌐
                </kbd>
              ) : (
                <kbd className="px-3 py-1.5 bg-surface-raised border border-border rounded-sm text-sm font-semibold text-foreground shadow-sm">
                  {displayValue}
                </kbd>
              )}
            </div>
            <span className="text-xs text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">
              {t("hotkeyInput.clickToChange")}
            </span>
          </div>
        ) : (
          /* Empty state */
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
            <span className="text-sm font-medium">{t("hotkeyInput.clickToSet")}</span>
          </div>
        )}
      </div>
    );
  }

  // Default variant: compact inline display
  return (
    <div
      ref={containerRef}
      tabIndex={disabled ? -1 : 0}
      role="button"
      aria-label={t("hotkeyInput.ariaLabel")}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={`
        relative overflow-hidden rounded-md border
        transition-colors duration-150 cursor-pointer select-none focus:outline-none
        ${
          disabled
            ? "bg-muted/30 border-border cursor-not-allowed opacity-50"
            : isCapturing
              ? "bg-primary/5 border-primary/30 shadow-[0_0_0_2px_rgba(37,99,212,0.1)]"
              : "bg-surface-1 border-border hover:border-border-hover hover:bg-surface-2"
        }
      `}
    >
      {isCapturing && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary animate-pulse" />
      )}

      <div className="px-4 py-3">
        {isCapturing ? (
          <>
            <div className="flex items-center justify-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                <span className="text-xs font-medium text-muted-foreground">
                  {t("hotkeyInput.recording")}
                </span>
              </div>
              {activeModifiers.size > 0 ? (
                <div className="flex items-center gap-1">
                  {Array.from(activeModifiers).map((mod) => (
                    <kbd
                      key={mod}
                      className="px-2 py-0.5 bg-primary/10 border border-primary/20 rounded-sm text-xs font-semibold text-primary"
                    >
                      {mod}
                    </kbd>
                  ))}
                  <span className="text-primary/40 text-xs">
                    {isFnHeld ? t("hotkeyInput.fnCaptureHint") : t("hotkeyInput.keyHint")}
                  </span>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {isMac ? t("hotkeyInput.tryShortcutMac") : t("hotkeyInput.tryShortcut")}
                </span>
              )}
            </div>
            {validationWarning && (
              <div className="flex items-center gap-1.5 mt-1.5 px-3 py-1.5 rounded-md bg-warning/8 border border-warning/20 dark:bg-warning/12 dark:border-warning/25">
                <AlertTriangle className="w-3 h-3 text-warning shrink-0" />
                <span className="text-xs text-warning dark:text-amber-400">
                  {validationWarning}
                </span>
              </div>
            )}
          </>
        ) : value ? (
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t("hotkeyInput.hotkeyLabel")}
            </span>
            <div className="flex items-center gap-2">
              {hotkeyParts.length > 0 ? (
                <div className="flex items-center gap-1">
                  {hotkeyParts.map((part, i) => (
                    <React.Fragment key={part}>
                      {i > 0 && <span className="text-muted-foreground/30 text-xs">+</span>}
                      <kbd className="px-2 py-0.5 bg-surface-raised border border-border rounded-sm text-xs font-semibold text-foreground">
                        {part}
                      </kbd>
                    </React.Fragment>
                  ))}
                </div>
              ) : isGlobe ? (
                <div className="flex items-center gap-1.5">
                  <kbd className="px-2 py-0.5 bg-surface-raised border border-border rounded-sm text-base">
                    🌐
                  </kbd>
                  <span className="text-xs text-muted-foreground">{t("hotkeyInput.globe")}</span>
                </div>
              ) : (
                <kbd className="px-2.5 py-1 bg-surface-raised border border-border rounded-sm text-xs font-semibold text-foreground">
                  {displayValue}
                </kbd>
              )}
              <span className="text-xs text-muted-foreground/50">
                {t("hotkeyInput.clickToChangeLower")}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <span className="text-sm font-medium">{t("hotkeyInput.clickToSet")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default HotkeyInput;

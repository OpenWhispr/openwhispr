import React, { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Trash2 } from "lucide-react";
import {
  formatHotkeyLabel,
  formatHotkeyLabelForPlatform,
  isGlobeLikeHotkey,
  sidedModifierToken,
} from "../../utils/hotkeys";
import { getPlatform, type Platform } from "../../utils/platform";

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

type ModifierKind = "ctrl" | "meta" | "alt" | "shift";

/** Kinds in the order they are shown and joined into a chord. */
const MODIFIER_KINDS: ModifierKind[] = ["ctrl", "meta", "alt", "shift"];

/** `KeyboardEvent.code` stem for each kind, so the right-side twin is derivable. */
const MODIFIER_CODE_STEM: Record<ModifierKind, string> = {
  ctrl: "Control",
  meta: "Meta",
  alt: "Alt",
  shift: "Shift",
};

/** Token for a modifier whose side is unknown, e.g. one held before capture began. */
function sidelessModifierToken(kind: ModifierKind, platform: Platform): string {
  switch (kind) {
    case "ctrl":
      return "Control";
    case "meta":
      return platform === "darwin" ? "Command" : "Super";
    case "alt":
      return "Alt";
    default:
      return "Shift";
  }
}

function heldModifierToken(
  kind: ModifierKind,
  code: string | undefined,
  platform: Platform
): string {
  return (code && sidedModifierToken(code, platform)) || sidelessModifierToken(kind, platform);
}

/**
 * Chip label for a held token. "Fn" is spelled out rather than passed through
 * formatHotkeyLabelForPlatform, which resolves it to the "Globe/Fn" name a
 * stored hotkey gets — too long for a chip that sits beside "+ key" and reads
 * as a second key rather than the one the user is holding.
 */
function heldModifierLabel(token: string, platform: Platform): string {
  return token === "Fn" ? "Fn" : formatHotkeyLabelForPlatform(token, platform);
}

/** Outcome of releasing a modifier-only chord: a hotkey, a reason it cannot be
    one, or nothing worth reacting to. */
type ModifierOnlyCapture =
  | { kind: "hotkey"; hotkey: string }
  | { kind: "needsRightSide"; held: string; rightSide: string }
  | null;

export interface HotkeyInputProps {
  value: string;
  onChange: (hotkey: string) => void;
  /** When provided, a remove button is revealed on hover while a hotkey is set. */
  onClear?: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  validate?: (hotkey: string) => string | null | undefined;
  onValidationError?: (message: string | null) => void;
  /** Modifiers currently held, as a side-qualified chord ("RightOption",
      "LeftControl+Shift"), or "" when nothing is held. Lets a caller that hides
      this input behind its own surface still show what is being pressed. */
  onHeldModifiersChange?: (chord: string) => void;
}

function mapKeyboardEventToHotkey(e: KeyboardEvent): string | null {
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
  variant?: "default" | "hero" | "capture-overlay";
}

export function HotkeyInput({
  value,
  onChange,
  onClear,
  onBlur,
  disabled = false,
  autoFocus = false,
  variant = "default",
  validate,
  onValidationError,
  onHeldModifiersChange,
}: HotkeyInputProps & HotkeyInputVariant) {
  const { t } = useTranslation();
  const [isCapturing, setIsCapturing] = useState(false);
  const [activeModifiers, setActiveModifiers] = useState<string[]>([]);
  const [validationWarning, setValidationWarning] = useState<string | null>(null);
  const [isFnHeld, setIsFnHeld] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const keyDownTimeRef = useRef<number>(0);
  const warningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnHeldRef = useRef(false);
  const fnCapturedKeyRef = useRef(false);
  const heldModifiersRef = useRef<Record<ModifierKind, boolean>>({
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  });
  const modifierCodesRef = useRef<Partial<Record<ModifierKind, string>>>({});
  const platform = getPlatform();
  const isMac = platform === "darwin";

  const MODIFIER_HOLD_THRESHOLD_MS = 200;

  const resolveModifierOnlyCapture = useCallback(
    (
      modifiers: Record<ModifierKind, boolean>,
      codes: Partial<Record<ModifierKind, string>>
    ): ModifierOnlyCapture => {
      const heldKinds = MODIFIER_KINDS.filter((kind) => modifiers[kind]);

      // A lone modifier is only capturable on the right side: that is the side
      // the native listeners report on its own, and it leaves the left-side key
      // free for ordinary chords.
      if (heldKinds.length === 1) {
        const kind = heldKinds[0];
        const token = heldModifierToken(kind, codes[kind], platform);
        if (token.startsWith("Right")) {
          return { kind: "hotkey", hotkey: token };
        }
        const rightSideToken =
          sidedModifierToken(`${MODIFIER_CODE_STEM[kind]}Right`, platform) ?? token;
        return {
          kind: "needsRightSide",
          held: formatHotkeyLabelForPlatform(token, platform),
          rightSide: formatHotkeyLabelForPlatform(rightSideToken, platform),
        };
      }

      if (heldKinds.length >= 2) {
        return {
          kind: "hotkey",
          hotkey: heldKinds.map((kind) => sidelessModifierToken(kind, platform)).join("+"),
        };
      }

      return null;
    },
    [platform]
  );

  const clearFnHeld = useCallback(() => {
    setIsFnHeld(false);
    fnHeldRef.current = false;
    fnCapturedKeyRef.current = false;
  }, []);

  const rejectCapture = useCallback(
    (message: string) => {
      if (warningTimeoutRef.current) {
        clearTimeout(warningTimeoutRef.current);
      }
      setValidationWarning(message);
      onValidationError?.(message);
      warningTimeoutRef.current = setTimeout(() => setValidationWarning(null), 4000);
      heldModifiersRef.current = { ctrl: false, meta: false, alt: false, shift: false };
      modifierCodesRef.current = {};
      setActiveModifiers([]);
      keyDownTimeRef.current = 0;
      clearFnHeld();
    },
    [onValidationError, clearFnHeld]
  );

  const finalizeCapture = useCallback(
    (hotkey: string) => {
      if (warningTimeoutRef.current) {
        clearTimeout(warningTimeoutRef.current);
        warningTimeoutRef.current = null;
      }

      if (validate) {
        const errorMsg = validate(hotkey);
        if (errorMsg) {
          rejectCapture(errorMsg);
          return;
        }
      }

      setValidationWarning(null);
      onValidationError?.(null);
      onChange(hotkey);
      setIsCapturing(false);
      setActiveModifiers([]);
      clearFnHeld();
      containerRef.current?.blur();
    },
    [validate, onValidationError, onChange, clearFnHeld, rejectCapture]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();

      // The user is attempting a new chord, so the previous rejection no longer
      // applies. This is where clearing belongs, not in handleFocus.
      onValidationError?.(null);

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

      const codes = modifierCodesRef.current;
      const held: string[] = [];
      const holdKind = (kind: ModifierKind) =>
        held.push(heldModifierToken(kind, codes[kind], platform));
      if (isMac) {
        if (e.metaKey) holdKind("meta");
        if (e.ctrlKey) holdKind("ctrl");
      } else {
        if (e.ctrlKey) holdKind("ctrl");
        if (e.metaKey) holdKind("meta");
      }
      if (e.altKey) holdKind("alt");
      if (e.shiftKey) holdKind("shift");
      if (fnHeldRef.current) held.push("Fn");
      setActiveModifiers(held);

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
    [disabled, isMac, platform, finalizeCapture, onValidationError]
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
          const capture = resolveModifierOnlyCapture(
            heldModifiersRef.current,
            modifierCodesRef.current
          );
          if (capture?.kind === "hotkey") {
            attempted = true;
            if (fnHeldRef.current) {
              fnCapturedKeyRef.current = true;
              finalizeCapture(`Fn+${capture.hotkey}`);
            } else {
              finalizeCapture(capture.hotkey);
            }
          } else if (capture?.kind === "needsRightSide" && !fnHeldRef.current) {
            // Silently dropping this release is what made a left-side Option or
            // Control look like the field was ignoring the key entirely.
            attempted = true;
            rejectCapture(
              t("hotkeyInput.singleModifierNeedsRightSide", {
                key: capture.held,
                alternative: capture.rightSide,
              })
            );
          }
        }
      }

      if (!attempted) {
        heldModifiersRef.current = { ctrl: false, meta: false, alt: false, shift: false };
        modifierCodesRef.current = {};
        setActiveModifiers(fnHeldRef.current ? ["Fn"] : []);
        keyDownTimeRef.current = 0;
      }
    },
    [disabled, resolveModifierOnlyCapture, finalizeCapture, rejectCapture, t]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled || !isCapturing) return;

      const mouseHotkey = e.button === 3 ? "MouseButton4" : e.button === 4 ? "MouseButton5" : null;
      if (!mouseHotkey) return;

      e.preventDefault();
      e.stopPropagation();
      finalizeCapture(mouseHotkey);
    },
    [disabled, isCapturing, finalizeCapture]
  );

  // Deliberately does not clear the parent's error (handleKeyDown does that on the
  // next real attempt). A rejected chord makes ShortcutSetupStep bump captureKey,
  // which remounts this input with autoFocus, so clearing here fired one frame
  // after the parent set the message and the rejection was never readable.
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
    setActiveModifiers([]);
    setValidationWarning(null);
    clearFnHeld();
    window.electronAPI?.setHotkeyListeningMode?.(false);
    onBlur?.();
  }, [onBlur, clearFnHeld]);

  useEffect(() => {
    if (!autoFocus) return;
    let cancelled = false;
    let frame: number | null = null;

    const focusCaptureSurface = async () => {
      if (platform === "win32") {
        // On Windows, focusing a DOM node does not bring an inactive native
        // window to the foreground. Main restores/focuses the BrowserWindow as
        // part of this handshake; waiting for it makes the first chord reliable.
        const listening = window.electronAPI?.setHotkeyListeningMode?.(true);
        if (listening) await listening.catch(() => undefined);
      }
      if (cancelled) return;

      frame = requestAnimationFrame(() => containerRef.current?.focus({ preventScroll: true }));
    };

    void focusCaptureSurface();
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [autoFocus, platform]);

  useEffect(() => {
    onHeldModifiersChange?.(activeModifiers.join("+"));
  }, [activeModifiers, onHeldModifiersChange]);

  useEffect(() => {
    return () => {
      window.electronAPI?.setHotkeyListeningMode?.(false);
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
      setActiveModifiers((prev) => (prev.includes("Fn") ? prev : [...prev, "Fn"]));
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
  const isGlobe = isGlobeLikeHotkey(value);
  const hotkeyParts = value?.includes("+") ? displayValue.split("+") : [];

  // mousedown is prevented so clicking never focuses the container and starts
  // capture; focus/key events are stopped so keyboard use doesn't either.
  const clearButton =
    onClear && value && !isCapturing && !disabled ? (
      <button
        type="button"
        aria-label={t("hotkeyInput.remove")}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onFocus={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClear();
        }}
        className="rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-ring/30 transition-opacity duration-150 text-muted-foreground/50 hover:text-destructive cursor-pointer"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    ) : null;

  if (variant === "capture-overlay") {
    return (
      <div
        ref={containerRef}
        tabIndex={disabled ? -1 : 0}
        role="button"
        aria-label={t("hotkeyInput.ariaLabel")}
        data-capturing={isCapturing || undefined}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onMouseDown={handleMouseDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className="absolute inset-0 z-10 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20"
      >
        <span className="sr-only">
          {validationWarning ??
            (isCapturing ? t("hotkeyInput.listening") : t("hotkeyInput.clickToSet"))}
        </span>
      </div>
    );
  }

  // Hero variant: large centered key display for onboarding
  if (variant === "hero") {
    return (
      <div
        ref={containerRef}
        tabIndex={disabled ? -1 : 0}
        role="button"
        aria-label={t("hotkeyInput.ariaLabel")}
        data-capturing={isCapturing || undefined}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onMouseDown={handleMouseDown}
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
            {activeModifiers.length > 0 ? (
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex items-center gap-1.5">
                  {activeModifiers.map((token) => (
                    <kbd
                      key={token}
                      className="px-2.5 py-1 bg-primary/10 border border-primary/20 rounded-sm text-xs font-semibold text-primary"
                    >
                      {heldModifierLabel(token, platform)}
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
        {clearButton && <span className="absolute top-2.5 right-2.5">{clearButton}</span>}
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
      data-capturing={isCapturing || undefined}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onMouseDown={handleMouseDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={`
        relative group overflow-hidden rounded-md border
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
              {activeModifiers.length > 0 ? (
                <div className="flex items-center gap-1">
                  {activeModifiers.map((token) => (
                    <kbd
                      key={token}
                      className="px-2 py-0.5 bg-primary/10 border border-primary/20 rounded-sm text-xs font-semibold text-primary"
                    >
                      {heldModifierLabel(token, platform)}
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
              {clearButton}
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

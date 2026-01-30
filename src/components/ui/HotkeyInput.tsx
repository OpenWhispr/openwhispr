import React, { useState, useCallback, useRef, useEffect } from "react";
import { formatHotkeyLabel } from "../../utils/hotkeys";

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
}

export function mapKeyboardEventToHotkey(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) {
    return null;
  }

  const baseKey = CODE_TO_KEY[e.code];
  if (!baseKey) {
    return null;
  }

  const modifiers: string[] = [];

  // Distinguish between Control and Command (Meta) keys
  // On macOS: Control = physical Ctrl key, Meta = Command key
  // On Windows/Linux: Control = Ctrl key, Meta = Windows/Super key
  const isMac = /Mac|Darwin/.test(navigator.platform);

  if (e.metaKey) {
    // Command key on macOS, Windows key on Windows/Linux
    modifiers.push(isMac ? "Command" : "Super");
  }
  if (e.ctrlKey) {
    // Control key - use explicit "Control" to avoid CommandOrControl mapping
    modifiers.push("Control");
  }
  if (e.altKey) {
    modifiers.push("Alt");
  }
  if (e.shiftKey) {
    modifiers.push("Shift");
  }

  return modifiers.length > 0 ? [...modifiers, baseKey].join("+") : baseKey;
}

export function HotkeyInput({
  value,
  onChange,
  onBlur,
  disabled = false,
  autoFocus = false,
}: HotkeyInputProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [activeModifiers, setActiveModifiers] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const lastCapturedHotkeyRef = useRef<string | null>(null);
  const isMac = typeof navigator !== "undefined" && /Mac|Darwin/.test(navigator.platform);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();

      const mods = new Set<string>();
      if (e.ctrlKey || e.metaKey) mods.add(isMac ? "Cmd" : "Ctrl");
      if (e.altKey) mods.add(isMac ? "Option" : "Alt");
      if (e.shiftKey) mods.add("Shift");
      setActiveModifiers(mods);

      const hotkey = mapKeyboardEventToHotkey(e.nativeEvent);
      if (hotkey) {
        lastCapturedHotkeyRef.current = hotkey;
        onChange(hotkey);
        setIsCapturing(false);
        setActiveModifiers(new Set());
        containerRef.current?.blur();
      }
    },
    [disabled, onChange, isMac]
  );

  const handleKeyUp = useCallback(() => {
    setActiveModifiers(new Set());
  }, []);

  const handleFocus = useCallback(() => {
    if (!disabled) {
      setIsCapturing(true);
      window.electronAPI?.setHotkeyListeningMode?.(true);
    }
  }, [disabled]);

  const handleBlur = useCallback(() => {
    setIsCapturing(false);
    setActiveModifiers(new Set());
    window.electronAPI?.setHotkeyListeningMode?.(false, lastCapturedHotkeyRef.current);
    lastCapturedHotkeyRef.current = null;
    onBlur?.();
  }, [onBlur]);

  useEffect(() => {
    if (autoFocus && containerRef.current) {
      containerRef.current.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    return () => {
      window.electronAPI?.setHotkeyListeningMode?.(false, null);
    };
  }, []);

  useEffect(() => {
    if (!isCapturing || !isMac) return;

    const dispose = window.electronAPI?.onGlobeKeyPressed?.(() => {
      lastCapturedHotkeyRef.current = "GLOBE";
      onChange("GLOBE");
      setIsCapturing(false);
      setActiveModifiers(new Set());
      containerRef.current?.blur();
    });

    return () => dispose?.();
  }, [isCapturing, isMac, onChange]);

  const displayValue = formatHotkeyLabel(value);
  const isGlobe = value === "GLOBE";

  const hotkeyParts = value?.includes("+") ? displayValue.split("+") : [];

  return (
    <div className="space-y-3">
      <div
        ref={containerRef}
        tabIndex={disabled ? -1 : 0}
        role="button"
        aria-label="Press a key combination to set hotkey"
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={`
          relative overflow-hidden
          rounded-xl border-2
          transition-all duration-300 ease-out
          cursor-pointer select-none
          focus:outline-none
          ${
            disabled
              ? "bg-gray-50 border-gray-200 cursor-not-allowed opacity-60"
              : isCapturing
                ? "bg-gradient-to-br from-indigo-50 to-purple-50 border-indigo-400 shadow-lg shadow-indigo-100"
                : "bg-white border-gray-200 hover:border-gray-300 hover:shadow-md"
          }
        `}
      >
        {isCapturing && (
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-500 animate-pulse" />
        )}

        <div className="px-6 py-5">
          {isCapturing ? (
            <div className="space-y-3">
              <div className="flex items-center justify-center gap-2">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                <span className="text-sm font-medium text-gray-600">Recording</span>
              </div>

              {activeModifiers.size > 0 ? (
                <div className="flex items-center justify-center gap-1.5">
                  {Array.from(activeModifiers).map((mod) => (
                    <kbd
                      key={mod}
                      className="px-2.5 py-1.5 bg-indigo-100 border border-indigo-200 rounded-lg text-sm font-semibold text-indigo-700 shadow-sm"
                    >
                      {mod}
                    </kbd>
                  ))}
                  <span className="text-indigo-400 font-medium">+</span>
                  <span className="px-2.5 py-1.5 border-2 border-dashed border-indigo-300 rounded-lg text-sm text-indigo-400">
                    key
                  </span>
                </div>
              ) : (
                <p className="text-center text-gray-500">Press any key or combination</p>
              )}

              <p className="text-xs text-center text-gray-400">
                {isMac ? "Try ⌘⇧K or ⌥Space" : "Try Ctrl+Shift+K or Alt+Space"}
              </p>
            </div>
          ) : value ? (
            <div className="flex flex-col items-center gap-2">
              {hotkeyParts.length > 0 ? (
                <div className="flex items-center justify-center gap-1.5">
                  {hotkeyParts.map((part, i) => (
                    <React.Fragment key={part}>
                      {i > 0 && <span className="text-gray-300 font-medium">+</span>}
                      <kbd className="px-3 py-2 bg-gray-100 border border-gray-200 rounded-lg text-base font-semibold text-gray-800 shadow-sm">
                        {part}
                      </kbd>
                    </React.Fragment>
                  ))}
                </div>
              ) : isGlobe ? (
                <div className="flex items-center gap-2">
                  <kbd className="px-4 py-2 bg-gradient-to-b from-gray-50 to-gray-100 border border-gray-200 rounded-xl text-2xl shadow-sm">
                    🌐
                  </kbd>
                  <span className="text-sm font-medium text-gray-600">Globe/Fn</span>
                </div>
              ) : (
                <kbd className="px-5 py-3 bg-gradient-to-b from-gray-50 to-gray-100 border border-gray-200 rounded-xl text-xl font-bold text-gray-800 shadow-sm min-w-[60px] text-center">
                  {displayValue}
                </kbd>
              )}

              <p className="text-xs text-gray-400">Click to change</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="flex items-center gap-2 text-gray-400">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707"
                  />
                </svg>
                <span className="font-medium">Click to set hotkey</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default HotkeyInput;

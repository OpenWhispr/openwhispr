import { useEffect, useRef } from "react";
import type React from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getLanguageLabel } from "../../utils/languageSupport";

interface PillCommandMenuProps {
  buttonRef: React.RefObject<HTMLDivElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  languageMenuTriggerRef: React.RefObject<HTMLDivElement | null>;
  showLanguageSwitcher: boolean;
  languageOptions: string[];
  preferredLanguage: string;
  onSelectLanguage: (code: string) => void;
  isRecording: boolean;
  agentAllowed: boolean;
  isHovered: boolean;
  setWindowInteractivity: (capture: boolean) => void;
  onToggleListening: () => void;
  onAskAssistant: () => void;
  onHide: () => void;
  onClose: () => void;
}

/**
 * The pill's right-click command menu. Mounted only while open; clicking
 * outside it (and outside the pill button that anchors it) closes it.
 */
export function PillCommandMenu({
  buttonRef,
  menuRef,
  languageMenuTriggerRef,
  showLanguageSwitcher,
  languageOptions,
  preferredLanguage,
  onSelectLanguage,
  isRecording,
  agentAllowed,
  isHovered,
  setWindowInteractivity,
  onToggleListening,
  onAskAssistant,
  onHide,
  onClose,
}: PillCommandMenuProps): React.JSX.Element {
  const { t } = useTranslation();
  const localMenuRef = useRef<HTMLDivElement>(null);
  const resolvedMenuRef = menuRef ?? localMenuRef;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      // The language-chip trigger is excluded too: its click handler swaps
      // the menus in a single commit. Closing here on the mousedown instead
      // would momentarily leave no menu open, releasing window focus — and
      // the in-flight blur event would close the menu the click is about
      // to open.
      const onLanguageTrigger =
        languageMenuTriggerRef.current?.contains(target) ?? false;
      if (
        !onLanguageTrigger &&
        resolvedMenuRef.current &&
        !resolvedMenuRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [buttonRef, languageMenuTriggerRef, resolvedMenuRef, onClose]);

  return (
    <div
      ref={resolvedMenuRef}
      className="absolute bottom-full right-0 mb-3 w-48 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg backdrop-blur-sm"
      onMouseEnter={() => {
        setWindowInteractivity(true);
      }}
      onMouseLeave={() => {
        if (!isHovered) {
          setWindowInteractivity(false);
        }
      }}
    >
      <button
        className="w-full px-3 py-2 text-left text-sm font-medium hover:bg-muted focus:bg-muted focus:outline-none"
        onClick={onToggleListening}
      >
        {isRecording ? t("app.commandMenu.stopListening") : t("app.commandMenu.startListening")}
      </button>
      {agentAllowed && (
        <>
          <div className="h-px bg-border" />
          <button
            className="w-full px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
            onClick={onAskAssistant}
          >
            {t("app.commandMenu.askAssistant")}
          </button>
        </>
      )}
      {showLanguageSwitcher && (
        <>
          <div className="h-px bg-border" />
          <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("app.commandMenu.language")}
          </div>
          <div className="max-h-36 overflow-y-auto pb-1">
            {languageOptions.map((code) => {
              const isActive = code === preferredLanguage;
              return (
                <button
                  key={code}
                  className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 hover:bg-muted focus:bg-muted focus:outline-none ${
                    isActive ? "text-primary font-medium" : ""
                  }`}
                  onClick={() => onSelectLanguage(code)}
                  role="menuitemradio"
                  aria-checked={isActive}
                >
                  <span className="truncate flex-1">{getLanguageLabel(code)}</span>
                  {isActive && <Check size={12} strokeWidth={2.5} className="shrink-0" />}
                </button>
              );
            })}
          </div>
        </>
      )}
      <div className="h-px bg-border" />
      <button
        className="w-full px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
        onClick={onHide}
      >
        {t("app.commandMenu.hideForNow")}
      </button>
    </div>
  );
}

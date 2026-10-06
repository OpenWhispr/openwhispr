import { useEffect } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { getLanguageLabel } from "../../utils/languageSupport";
import { Check } from "../icons";

interface PillCommandMenuProps {
  buttonRef: React.RefObject<HTMLDivElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  languageMenuTriggerRef: React.RefObject<HTMLDivElement | null>;
  showLanguageSwitcher: boolean;
  languageOptions: string[];
  preferredLanguage: string;
  onSelectLanguage: (code: string) => void;
  align: "left" | "right" | "center";
  isRecording: boolean;
  agentAllowed: boolean;
  meetingAllowed: boolean;
  isHovered: boolean;
  setWindowInteractivity: (capture: boolean) => void;
  onToggleListening: () => void;
  onAskAssistant: () => void;
  onStartMeeting: () => void;
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
  align,
  isRecording,
  agentAllowed,
  meetingAllowed,
  isHovered,
  setWindowInteractivity,
  onToggleListening,
  onAskAssistant,
  onStartMeeting,
  onHide,
  onClose,
}: PillCommandMenuProps): React.JSX.Element {
  const { t } = useTranslation();

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      // The language-chip trigger is excluded too: its click handler swaps
      // the menus in a single commit. Closing here on mousedown would release
      // window focus before the language menu opens.
      const onLanguageTrigger = languageMenuTriggerRef.current?.contains(target) ?? false;
      if (
        !onLanguageTrigger &&
        menuRef.current &&
        !menuRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [buttonRef, languageMenuTriggerRef, menuRef, onClose]);

  // The pill docks against a physical window edge and the window clips anything past it (#2064),
  // so the menu anchors on that same side, never on a logical start/end.
  const alignClass =
    align === "right" ? "right-0" : align === "left" ? "left-0" : "left-1/2 -translate-x-1/2";

  return (
    <div
      ref={menuRef}
      className={`absolute bottom-full ${alignClass} mb-3 w-48 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg backdrop-blur-sm`}
      onMouseEnter={() => setWindowInteractivity(true)}
      onMouseLeave={() => {
        if (!isHovered) setWindowInteractivity(false);
      }}
    >
      <button
        className="w-full px-3 py-2 text-start text-sm font-medium hover:bg-muted focus:bg-muted focus:outline-none"
        onClick={onToggleListening}
      >
        {isRecording ? t("app.commandMenu.stopListening") : t("app.commandMenu.startListening")}
      </button>
      {/* Opening the Agent panel mid-recording would strand the capture with no
          surface (a translation recording becomes invisible and unstoppable).
          Stop or finish the recording first. */}
      {agentAllowed && !isRecording && (
        <>
          <div className="h-px bg-border" />
          <button
            className="w-full px-3 py-2 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none"
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
                  className={`w-full px-3 py-1.5 text-start text-sm flex items-center gap-2 hover:bg-muted focus:bg-muted focus:outline-none ${
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
      {meetingAllowed && !isRecording && (
        <>
          <div className="h-px bg-border" />
          <button
            className="w-full px-3 py-2 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none"
            onClick={onStartMeeting}
          >
            {t("app.commandMenu.startMeetingRecording")}
          </button>
        </>
      )}
      <div className="h-px bg-border" />
      <button
        className="w-full px-3 py-2 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none"
        onClick={onHide}
      >
        {t("app.commandMenu.hideForNow")}
      </button>
    </div>
  );
}

import { useEffect, useRef } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

interface PillCommandMenuProps {
  buttonRef: React.RefObject<HTMLDivElement | null>;
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
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (
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
  }, [buttonRef, onClose]);

  return (
    <div
      ref={menuRef}
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
      {/* Opening the Agent panel mid-recording would strand the capture with no
          surface (a translation recording becomes invisible AND un-stoppable:
          its hotkey is blocked while the panel is open and Escape belongs to the
          panel). Stop or finish the recording first. */}
      {agentAllowed && !isRecording && (
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

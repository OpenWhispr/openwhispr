import { useEffect, useRef } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

interface PillCommandMenuProps {
  buttonRef: React.RefObject<HTMLDivElement | null>;
  isRecording: boolean;
  agentAllowed: boolean;
  meetingAllowed: boolean;
  isHovered: boolean;
  anchor?: "left" | "right" | "center";
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
  isRecording,
  agentAllowed,
  meetingAllowed,
  isHovered,
  anchor = "right",
  setWindowInteractivity,
  onToggleListening,
  onAskAssistant,
  onStartMeeting,
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

  // The menu is wider than the pill, and anything past the transparent window's
  // edge is clipped away. The window grows away from the side the pill is docked
  // to (rightward from a left dock, both ways from center), so the menu opens
  // the same way. It used to be right-aligned always, which put it entirely
  // off-window for a pill docked on the left. Physical left/right on purpose:
  // the window geometry is physical and must not flip under an RTL UI.
  const horizontalAnchor =
    anchor === "left" ? "left-0" : anchor === "center" ? "left-1/2 -translate-x-1/2" : "right-0";

  return (
    <div
      ref={menuRef}
      className={`absolute bottom-full ${horizontalAnchor} mb-3 w-48 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg backdrop-blur-sm`}
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
        className="w-full px-3 py-2 text-start text-sm font-medium hover:bg-muted focus:bg-muted focus:outline-none"
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
            className="w-full px-3 py-2 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none"
            onClick={onAskAssistant}
          >
            {t("app.commandMenu.askAssistant")}
          </button>
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

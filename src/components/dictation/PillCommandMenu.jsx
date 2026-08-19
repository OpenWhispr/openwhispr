import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

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
}) {
  const { t } = useTranslation();
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target)
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

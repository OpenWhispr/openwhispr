import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Minus, Square, X, Copy } from "lucide-react";
import { useWindowControls } from "../hooks/useWindowControls";

export default function WindowControls() {
  const { t } = useTranslation();
  const { isMaximized, minimize, toggleMaximize, close } = useWindowControls();

  const minimizeLabel = t("windowControls.minimize");
  const maximizeLabel = t(isMaximized ? "windowControls.restore" : "windowControls.maximize");
  const closeLabel = t("windowControls.close");

  return (
    <div className="flex items-center gap-1 pointer-events-auto">
      <Button
        variant="ghost"
        size="icon"
        onClick={minimize}
        title={minimizeLabel}
        aria-label={minimizeLabel}
        className="h-8 w-8"
      >
        <Minus size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleMaximize}
        title={maximizeLabel}
        aria-label={maximizeLabel}
        className="h-8 w-8"
      >
        {isMaximized ? <Copy size={14} /> : <Square size={12} />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={close}
        className="h-8 w-8 hover:text-destructive hover:bg-destructive/10"
        title={closeLabel}
        aria-label={closeLabel}
      >
        <X size={14} />
      </Button>
    </div>
  );
}

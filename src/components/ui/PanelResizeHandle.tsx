import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";

interface PanelResizeHandleProps {
  /** The panel's edge it sits on, inside the panel. */
  edge: "start" | "end";
  isResizing: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  className?: string;
}

/** A strip along a panel's edge that resizes it when dragged; a small grip marks it on hover. */
export function PanelResizeHandle({
  edge,
  isResizing,
  onPointerDown,
  className,
}: PanelResizeHandleProps) {
  const { t } = useTranslation();
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("common.resizePanel")}
      onPointerDown={onPointerDown}
      className={cn(
        "group/resize absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none",
        edge === "end" ? "end-0" : "start-0",
        className
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 start-1/2 h-8 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/20 opacity-0 transition-opacity duration-150 group-hover/resize:opacity-100 rtl:translate-x-1/2",
          isResizing && "opacity-100"
        )}
      />
    </div>
  );
}

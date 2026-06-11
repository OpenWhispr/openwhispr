import React from "react";
import WindowControls from "./WindowControls";

interface TitleBarProps {
  title?: string;
  showTitle?: boolean;
  children?: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
  center?: React.ReactNode;
}

export default function TitleBar({
  title = "",
  showTitle = false,
  children,
  className = "",
  actions,
  center,
}: TitleBarProps) {
  const platform =
    typeof window !== "undefined" && window.electronAPI?.getPlatform
      ? window.electronAPI.getPlatform()
      : "darwin";

  return (
    <div className={`bg-background border-b border-border select-none ${className}`}>
      <div
        className="relative flex items-center justify-between h-12 px-4"
        style={{ WebkitAppRegion: "drag" }}
      >
        {center && (
          <div
            className="absolute left-1/2 -translate-x-1/2"
            style={{ WebkitAppRegion: "no-drag" }}
          >
            {center}
          </div>
        )}
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" }}>
          {platform !== "darwin" ? (
            actions
          ) : (
            <>
              {showTitle && title && (
                <h1 className="text-sm font-semibold text-foreground">{title}</h1>
              )}
              {children}
            </>
          )}
        </div>

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" }}>
          {platform !== "darwin" ? <WindowControls /> : actions}
        </div>
      </div>
    </div>
  );
}

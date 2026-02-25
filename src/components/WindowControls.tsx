import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Minus, Square, X, Copy } from "lucide-react";

export default function WindowControls() {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let mounted = true;

    const syncIsMaximized = async () => {
      try {
        const maximized = await window.electronAPI?.windowIsMaximized?.();
        if (mounted) setIsMaximized(!!maximized);
      } catch {}
    };

    syncIsMaximized();
    const intervalId = setInterval(syncIsMaximized, 1000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, []);

  const handleMinimize = async () => {
    try {
      await window.electronAPI?.windowMinimize?.();
    } catch {}
  };

  const handleMaximize = async () => {
    try {
      await window.electronAPI?.windowMaximize?.();
      const maximized = await window.electronAPI?.windowIsMaximized?.();
      setIsMaximized(!!maximized);
    } catch {}
  };

  const handleClose = async () => {
    try {
      await window.electronAPI?.windowClose?.();
    } catch {}
  };

  return (
    <div className="flex items-center gap-1 pointer-events-auto">
      <Button
        variant="ghost"
        size="icon"
        onClick={handleMinimize}
        title={t("windowControls.minimize")}
        className="h-8 w-8"
      >
        <Minus size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleMaximize}
        title={isMaximized ? t("windowControls.restore") : t("windowControls.maximize")}
        className="h-8 w-8"
      >
        {isMaximized ? <Copy size={14} /> : <Square size={12} />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleClose}
        className="h-8 w-8 hover:text-destructive hover:bg-destructive/10"
        title={t("windowControls.close")}
      >
        <X size={14} />
      </Button>
    </div>
  );
}

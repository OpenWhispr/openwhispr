import React from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Lock } from "lucide-react";

interface ProcessingModeSelectorProps {
  useLocalWhisper: boolean;
  setUseLocalWhisper: (value: boolean) => void;
  className?: string;
}

export default function ProcessingModeSelector({
  useLocalWhisper,
  setUseLocalWhisper,
  className = "",
}: ProcessingModeSelectorProps) {
  const { t } = useTranslation();
  return (
    <div
      className={`relative flex p-0.5 rounded-lg bg-white/5 dark:bg-white/3 border border-white/10 dark:border-white/5 ${className}`}
    >
      {/* Sliding indicator */}
      <div
        className={`absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md bg-white/10 dark:bg-white/8 border border-white/10 transition-transform duration-200 ease-out ${
          useLocalWhisper ? "translate-x-[calc(100%+4px)]" : "translate-x-0"
        }`}
      />

      <button
        onClick={() => setUseLocalWhisper(false)}
        className={`relative z-10 flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md transition-colors duration-150 ${
          !useLocalWhisper ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Cloud className="w-4 h-4" />
        <span className="text-sm font-medium">{t("common.cloud")}</span>
        {!useLocalWhisper && (
          <span className="text-xs text-emerald-500 font-medium">{t("common.fast")}</span>
        )}
      </button>

      <button
        onClick={() => setUseLocalWhisper(true)}
        className={`relative z-10 flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md transition-colors duration-150 ${
          useLocalWhisper ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Lock className="w-4 h-4" />
        <span className="text-sm font-medium">{t("common.local")}</span>
        {useLocalWhisper && (
          <span className="text-xs text-primary font-medium">{t("common.private")}</span>
        )}
      </button>
    </div>
  );
}

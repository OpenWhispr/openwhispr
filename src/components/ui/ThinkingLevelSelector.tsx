import { Zap, Brain } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ThinkingLevelSelectorProps {
  /** true = minimal thinking (maps to disableThinking), false = high */
  minimal: boolean;
  onChange: (minimal: boolean) => void;
}

/**
 * Two-option segmented control ("Minimal" / "High") for models whose thinking
 * can't be turned off, only dialed down (e.g. Gemma 4 on the Gemini API). Maps
 * onto the same `disableThinking` flag the plain toggle uses: minimal = true.
 */
export function ThinkingLevelSelector({ minimal, onChange }: ThinkingLevelSelectorProps) {
  const { t } = useTranslation();

  const buttonClass = (active: boolean) =>
    `flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
      active ? "bg-surface-raised text-foreground" : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="inline-flex shrink-0 gap-0.5 rounded-md border border-border-subtle bg-surface-1 p-0.5">
      <button type="button" onClick={() => onChange(true)} className={buttonClass(minimal)}>
        <Zap className="h-3.5 w-3.5" />
        {t("reasoning.thinkingLevel.minimal")}
      </button>
      <button type="button" onClick={() => onChange(false)} className={buttonClass(!minimal)}>
        <Brain className="h-3.5 w-3.5" />
        {t("reasoning.thinkingLevel.high")}
      </button>
    </div>
  );
}

import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import type { HotkeyBinding } from "../../types/hotkeyBindings";
import { HotkeyInput } from "./HotkeyInput";
import LanguageSelector from "./LanguageSelector";
import { ActivationModeSelector } from "./ActivationModeSelector";
import { DictationModeSelector } from "./DictationModeSelector";
import { getValidationMessage } from "../../utils/hotkeyValidator";
import { getPlatform } from "../../utils/platform";

interface HotkeyBindingRowProps {
  binding: HotkeyBinding;
  onUpdate: (updates: Partial<HotkeyBinding>) => void;
  onRemove: () => void;
  otherHotkeys: string[];
  isUsingGnomeHotkeys: boolean;
}

export function HotkeyBindingRow({
  binding,
  onUpdate,
  onRemove,
  otherHotkeys,
  isUsingGnomeHotkeys,
}: HotkeyBindingRowProps) {
  const { t } = useTranslation();

  const validate = useCallback(
    (hotkey: string) => getValidationMessage(hotkey, getPlatform(), otherHotkeys),
    [otherHotkeys]
  );

  return (
    <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm">
      <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-2.5">
        <LanguageSelector
          value={binding.language}
          onChange={(lang) => onUpdate({ language: lang })}
          className="w-36 shrink-0"
        />

        <div className="flex-1 min-w-0">
          <HotkeyInput
            value={binding.hotkey}
            onChange={(hotkey) => onUpdate({ hotkey })}
            validate={validate}
          />
        </div>

        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 p-1.5 rounded-md text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 transition-colors duration-150"
          aria-label={t("hotkeyBindings.removeBinding")}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-3 pb-2.5 flex items-center gap-2">
        {!isUsingGnomeHotkeys && (
          <ActivationModeSelector
            value={binding.activationMode}
            onChange={(mode) => onUpdate({ activationMode: mode })}
            variant="compact"
          />
        )}
        <DictationModeSelector
          value={binding.dictationMode}
          onChange={(mode) => onUpdate({ dictationMode: mode })}
          variant="compact"
        />
      </div>
    </div>
  );
}

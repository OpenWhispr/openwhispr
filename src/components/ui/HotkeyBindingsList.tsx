import { useCallback } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { HotkeyBindingRow } from "./HotkeyBindingRow";
import type { HotkeyBinding } from "../../types/hotkeyBindings";

const MAX_BINDINGS = 20;

interface HotkeyBindingsListProps {
  isUsingGnomeHotkeys: boolean;
}

export function HotkeyBindingsList({ isUsingGnomeHotkeys }: HotkeyBindingsListProps) {
  const { t } = useTranslation();
  const bindings = useSettingsStore((s) => s.hotkeyBindings ?? []);
  const setHotkeyBindings = useSettingsStore((s) => s.setHotkeyBindings);

  const handleUpdate = useCallback(
    (id: string, updates: Partial<HotkeyBinding>) => {
      setHotkeyBindings(bindings.map((b) => (b.id === id ? { ...b, ...updates } : b)));
    },
    [bindings, setHotkeyBindings]
  );

  const handleRemove = useCallback(
    (id: string) => {
      setHotkeyBindings(bindings.filter((b) => b.id !== id));
    },
    [bindings, setHotkeyBindings]
  );

  const handleAdd = useCallback(() => {
    const newBinding: HotkeyBinding = {
      id: crypto.randomUUID(),
      hotkey: "",
      language: "auto",
      activationMode: "tap",
      dictationMode: "transcription",
    };
    setHotkeyBindings([...bindings, newBinding]);
  }, [bindings, setHotkeyBindings]);

  return (
    <div className="space-y-2">
      {bindings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 dark:border-border-subtle/50 px-4 py-6 text-center">
          <p className="text-xs text-muted-foreground/70">{t("hotkeyBindings.emptyState")}</p>
        </div>
      ) : (
        bindings.map((binding) => (
          <HotkeyBindingRow
            key={binding.id}
            binding={binding}
            onUpdate={(updates) => handleUpdate(binding.id, updates)}
            onRemove={() => handleRemove(binding.id)}
            otherHotkeys={bindings
              .filter((b) => b.id !== binding.id && b.hotkey)
              .map((b) => b.hotkey)}
            isUsingGnomeHotkeys={isUsingGnomeHotkeys}
          />
        ))
      )}

      {bindings.length < MAX_BINDINGS && (
        <button
          type="button"
          onClick={handleAdd}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-border/50 dark:border-border-subtle/50 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border hover:bg-surface-1/50 transition-colors duration-150"
        >
          <Plus className="w-3.5 h-3.5" />
          {t("hotkeyBindings.addHotkey")}
        </button>
      )}
    </div>
  );
}

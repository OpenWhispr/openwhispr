import type { TFunction } from "i18next";
import { getValidationMessage, normalizeHotkey } from "./hotkeyValidator";
import { parseHotkeyList } from "./hotkeys";
import { getPlatform } from "./platform";

export function validateHotkeyForSlot(
  hotkey: string,
  excludeSlots: Record<string, string>,
  t: TFunction
): string | null {
  const platform = getPlatform();
  const formatError = getValidationMessage(hotkey, platform);
  if (formatError) return formatError;

  const normalized = normalizeHotkey(hotkey, platform);

  // A slot's value may be a comma-separated hotkey list (#936) — conflict if
  // the candidate matches any entry.
  for (const [labelKey, otherValue] of Object.entries(excludeSlots)) {
    const conflicts = parseHotkeyList(otherValue).some(
      (other) => normalizeHotkey(other, platform) === normalized
    );
    if (conflicts) {
      return t("hotkey.errors.slotConflict", { slot: t(labelKey) });
    }
  }

  return null;
}

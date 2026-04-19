import type { TFunction } from "i18next";
import { getValidationMessage, normalizeHotkey } from "./hotkeyValidator";
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

  for (const [labelKey, otherHotkey] of Object.entries(excludeSlots)) {
    if (otherHotkey && normalizeHotkey(otherHotkey, platform) === normalized) {
      return t("hotkey.errors.slotConflict", { slot: t(labelKey) });
    }
  }

  return null;
}

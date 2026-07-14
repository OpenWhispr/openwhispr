import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "./button";
import { HotkeyInput } from "./HotkeyInput";
import { parseHotkeyList, serializeHotkeyList } from "../../utils/hotkeys";
import { normalizeHotkey } from "../../utils/hotkeyValidator";
import { getPlatform } from "../../utils/platform";

export interface HotkeyListInputProps {
  /** Comma-separated list of hotkeys (a single hotkey is just a one-item list). */
  value: string;
  /**
   * Called with the new comma-separated list whenever it has at least one entry.
   * If it resolves to `false`, the optimistic UI change is rolled back.
   */
  onChange: (list: string) => unknown;
  /** Called when the list becomes empty (removing the last entry). Omit to make the slot required. */
  onClear?: () => unknown;
  disabled?: boolean;
  /** When true, the last remaining hotkey cannot be removed and the list is never emptied. */
  required?: boolean;
  /** Cap on list size, e.g. 1 on backends that only apply the primary hotkey. */
  maxHotkeys?: number;
  /** Per-hotkey validation (e.g. cross-slot conflicts). Receives a single hotkey. */
  validate?: (hotkey: string) => string | null | undefined;
  /** Optional content shown on the right of the action row (e.g. a "Reset" link). */
  footerEnd?: ReactNode;
}

/**
 * A slot's hotkeys as a stack of editable {@link HotkeyInput} rows plus an
 * "Add another hotkey" button (issue #936). The visible list is optimistic
 * local state so add/remove/edit apply instantly; external `value` changes are
 * adopted, and an `onChange`/`onClear` that resolves to `false` rolls back.
 */
export function HotkeyListInput({
  value,
  onChange,
  onClear,
  disabled = false,
  required = false,
  maxHotkeys = Infinity,
  validate,
  footerEnd,
}: HotkeyListInputProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<string[]>(() => parseHotkeyList(value));
  const [adding, setAdding] = useState(false);
  const platform = getPlatform();

  // Adopt external changes to `value` (other windows, async revert on failure)
  // without clobbering an in-flight optimistic edit whose round-trip settles to
  // the same list.
  useEffect(() => {
    setItems((current) => {
      const incoming = parseHotkeyList(value);
      return serializeHotkeyList(incoming) === serializeHotkeyList(current) ? current : incoming;
    });
  }, [value]);

  const isSameHotkey = (a: string, b: string) =>
    normalizeHotkey(a, platform) === normalizeHotkey(b, platform);

  // Block binding the same hotkey twice within this slot (normalized, so alias
  // spellings collide too), then defer to the caller's cross-slot validation.
  const makeValidate = (excludeIndex: number) => (hotkey: string) => {
    if (items.some((existing, i) => i !== excludeIndex && isSameHotkey(existing, hotkey))) {
      return t("hotkeyInput.duplicate");
    }
    return validate?.(hotkey);
  };

  // Roll back only if the optimistic value is still current — an external
  // adoption that happened while the round-trip was in flight wins.
  const commit = async (next: string[]) => {
    const previous = items;
    setItems(next);
    const result = await onChange(serializeHotkeyList(next));
    if (result === false) setItems((current) => (current === next ? previous : current));
  };

  const replaceAt = (index: number, next: string) => {
    void commit(items.map((h, i) => (i === index ? next : h)));
  };

  const removeAt = async (index: number) => {
    const remaining = items.filter((_, i) => i !== index);
    if (remaining.length > 0) {
      void commit(remaining);
      return;
    }
    const previous = items;
    setItems(remaining);
    const result = await onClear?.();
    if (result === false) setItems((current) => (current === remaining ? previous : current));
  };

  const addHotkey = (hotkey: string) => {
    setAdding(false);
    if (!hotkey || items.some((existing) => isSameHotkey(existing, hotkey))) return;
    void commit([...items, hotkey]);
  };

  const canRemove = !required || items.length > 1;
  const showAdd = !adding && items.length > 0 && items.length < maxHotkeys;

  return (
    <div className="flex flex-col gap-2">
      {items.map((hotkey, index) => (
        <HotkeyInput
          key={`${hotkey}-${index}`}
          value={hotkey}
          onChange={(next) => replaceAt(index, next)}
          onClear={canRemove ? () => void removeAt(index) : undefined}
          disabled={disabled}
          validate={makeValidate(index)}
        />
      ))}

      {(items.length === 0 || adding) && (
        <HotkeyInput
          value=""
          autoFocus={adding}
          onChange={addHotkey}
          onBlur={() => setAdding(false)}
          disabled={disabled}
          validate={makeValidate(-1)}
        />
      )}

      {(showAdd || footerEnd) && !adding && (
        <div className="flex items-center justify-between gap-3 mt-0.5">
          {showAdd ? (
            <Button
              type="button"
              variant="outline-flat"
              size="sm"
              onClick={() => setAdding(true)}
              disabled={disabled}
            >
              <Plus className="w-3.5 h-3.5" />
              {t("hotkeyInput.addAnother")}
            </Button>
          ) : (
            <span />
          )}
          {footerEnd}
        </div>
      )}
    </div>
  );
}

export default HotkeyListInput;

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { HotkeyInput } from "./HotkeyInput";
import { parseHotkeyList, serializeHotkeyList } from "../../utils/hotkeys";

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
  /** Per-hotkey validation (e.g. cross-slot conflicts). Receives a single hotkey. */
  validate?: (hotkey: string) => string | null | undefined;
  /** Override the "Add another hotkey" button label. */
  addLabel?: string;
  /** Optional content shown on the right of the action row (e.g. a "Reset" link). */
  footerEnd?: ReactNode;
}

/**
 * Renders a slot's hotkeys as a stack of editable rows plus an "Add another"
 * button, so one action (dictation, agent, …) can be triggered from several
 * keys/keyboards (issue #936). Each row reuses {@link HotkeyInput}; the row's
 * own remove (trash) control deletes that entry.
 *
 * The visible list is driven by local optimistic state so add/remove/edit update
 * instantly instead of waiting on the backend round-trip (which would otherwise
 * make the list flicker/jump as the persisted value lags behind). External
 * changes to `value` (cross-window sync, or a failed update reverting the store)
 * are adopted; a failed `onChange`/`onClear` (resolving to `false`) rolls the
 * optimistic change back.
 */
export function HotkeyListInput({
  value,
  onChange,
  onClear,
  disabled = false,
  required = false,
  validate,
  addLabel,
  footerEnd,
}: HotkeyListInputProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<string[]>(() => parseHotkeyList(value));
  const [adding, setAdding] = useState(false);

  // Adopt external changes to `value` (other windows, async revert on failure)
  // without clobbering an in-flight optimistic edit whose round-trip settles to
  // the same list.
  useEffect(() => {
    setItems((current) => {
      const incoming = parseHotkeyList(value);
      return serializeHotkeyList(incoming) === serializeHotkeyList(current) ? current : incoming;
    });
  }, [value]);

  // Block binding the same hotkey twice within this slot, then defer to the
  // caller's cross-slot validation. `excludeIndex` is the row being edited.
  const makeValidate = (excludeIndex: number) => (hotkey: string) => {
    if (items.some((existing, i) => existing === hotkey && i !== excludeIndex)) {
      return t("hotkeyInput.duplicate");
    }
    return validate?.(hotkey);
  };

  const commit = async (next: string[]) => {
    const previous = items;
    setItems(next); // optimistic
    const result = await onChange(serializeHotkeyList(next));
    if (result === false) setItems(previous); // roll back on failure
  };

  const replaceAt = (index: number, next: string) => {
    void commit(items.map((h, i) => (i === index ? next : h)));
  };

  const removeAt = async (index: number) => {
    const remaining = items.filter((_, i) => i !== index);
    if (remaining.length === 0) {
      const previous = items;
      setItems([]); // optimistic
      const result = await onClear?.();
      if (result === false) setItems(previous);
    } else {
      void commit(remaining);
    }
  };

  const addHotkey = (hotkey: string) => {
    setAdding(false);
    if (!hotkey || items.includes(hotkey)) return;
    void commit([...items, hotkey]);
  };

  const canRemove = !required || items.length > 1;

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

      {adding && (
        <HotkeyInput
          value=""
          autoFocus
          onChange={addHotkey}
          onBlur={() => setAdding(false)}
          disabled={disabled}
          validate={makeValidate(-1)}
        />
      )}

      {!adding && (
        <div className="flex items-center justify-between gap-3 mt-0.5">
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-surface-2 hover:border-border-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" />
            {addLabel || (items.length === 0 ? t("hotkeyInput.add") : t("hotkeyInput.addAnother"))}
          </button>
          {footerEnd}
        </div>
      )}
    </div>
  );
}

export default HotkeyListInput;

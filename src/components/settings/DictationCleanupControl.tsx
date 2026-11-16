import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "../icons";
import { cn } from "../lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

/** Stored as the pipeline's own vocabulary; the words below are a display mapping. */
export type DictationCleanupMode = "raw" | "cleaned" | null;

const SELECT_VALUES = {
  app: "app",
  on: "cleaned",
  off: "raw",
} as const;

export interface DictationCleanupControlProps {
  mode: DictationCleanupMode;
  /** The shortcut this row binds, for the controls' accessible names. */
  hotkeyLabel?: string;
  onChange: (mode: DictationCleanupMode) => void;
  disabled?: boolean;
  /** Collapsed by default; pass true for a row that should open mounted (evidence, tests). */
  defaultOpen?: boolean;
}

/**
 * One dictation shortcut's cleanup override: a disclosure holding a three-way
 * selector. Collapsed and on "Use app setting" by default, so a user who never
 * opens it sees exactly what they saw before this existed; a row that forces a
 * mode says so in its summary while collapsed.
 *
 * Hand-rolled rather than Collapsible/accordion: there is no generic
 * Collapsible, and accordion.tsx hard-codes gray-* colours.
 */
export function DictationCleanupControl({
  mode,
  hotkeyLabel,
  onChange,
  disabled = false,
  defaultOpen = false,
}: DictationCleanupControlProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  // The visible label sits in an adjacent span, which names nothing: with one
  // of these per row, "Text cleanup" alone would also be ambiguous. Both
  // controls therefore carry the row's shortcut in their accessible name.
  const accessibleName = hotkeyLabel
    ? t("settingsPage.general.hotkey.cleanup.labelForRow", { hotkey: hotkeyLabel })
    : t("settingsPage.general.hotkey.cleanup.label");
  const toggleName = hotkeyLabel
    ? t("settingsPage.general.hotkey.cleanup.customizeForRow", { hotkey: hotkeyLabel })
    : t("settingsPage.general.hotkey.cleanup.customize");

  const value =
    mode === "cleaned" ? SELECT_VALUES.on : mode === "raw" ? SELECT_VALUES.off : SELECT_VALUES.app;
  const summary =
    mode === "cleaned"
      ? t("settingsPage.general.hotkey.cleanup.summaryOn")
      : mode === "raw"
        ? t("settingsPage.general.hotkey.cleanup.summaryOff")
        : null;
  const hint =
    mode === "cleaned"
      ? t("settingsPage.general.hotkey.cleanup.alwaysOnHint")
      : mode === "raw"
        ? t("settingsPage.general.hotkey.cleanup.alwaysOffHint")
        : null;

  return (
    <div className="ps-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={toggleName}
          onClick={() => setOpen((current) => !current)}
          className="flex items-center gap-1 text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={cn("h-3 w-3 transition-transform duration-200", open && "rotate-180")}
          />
          {t("settingsPage.general.hotkey.cleanup.customize")}
        </button>
        {/* A forced mode is visible without opening the row. */}
        {!open && summary && (
          <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {summary}
          </span>
        )}
      </div>

      <div
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground/80">
              {t("settingsPage.general.hotkey.cleanup.label")}
            </span>
            <Select
              value={value}
              disabled={disabled}
              onValueChange={(next) =>
                onChange(next === SELECT_VALUES.app ? null : (next as "raw" | "cleaned"))
              }
            >
              <SelectTrigger
                aria-label={accessibleName}
                className="h-7 w-40 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value={SELECT_VALUES.app}
                  className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                >
                  {t("settingsPage.general.hotkey.cleanup.useAppSetting")}
                </SelectItem>
                <SelectItem
                  value={SELECT_VALUES.on}
                  className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                >
                  {t("settingsPage.general.hotkey.cleanup.alwaysOn")}
                </SelectItem>
                <SelectItem
                  value={SELECT_VALUES.off}
                  className="text-xs py-1.5 ps-2.5 pe-7 rounded-md"
                >
                  {t("settingsPage.general.hotkey.cleanup.alwaysOff")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {hint && <p className="mt-1.5 text-xs text-muted-foreground/70">{hint}</p>}
        </div>
      </div>
    </div>
  );
}

export default DictationCleanupControl;

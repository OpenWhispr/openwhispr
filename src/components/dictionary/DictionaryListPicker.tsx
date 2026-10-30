import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Lock } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip } from "../ui/tooltip";
import { cn } from "../lib/utils";
import type { ListKey } from "../../stores/sharedDictionaryStore";
import type { PickerEntry } from "./dictionaryViewModel";

interface DictionaryListPickerProps {
  entries: PickerEntry[];
  selected: ListKey;
  onSelect: (list: ListKey) => void;
}

function PickerButton({
  entry,
  selected,
  onSelect,
}: {
  entry: PickerEntry;
  selected: boolean;
  onSelect: (list: ListKey) => void;
}): ReactElement {
  const { t } = useTranslation();
  const nested = entry.key === "workspace" || entry.key.startsWith("space:");
  return (
    <DropdownMenuItem
      data-list-key={entry.key}
      role="menuitemradio"
      aria-checked={selected}
      aria-current={selected ? "true" : undefined}
      textValue={entry.label}
      onSelect={() => onSelect(entry.key)}
      className={cn(
        "flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs",
        nested && "ps-4",
        selected && "bg-muted",
        entry.locked && !selected && "opacity-60"
      )}
    >
      <span dir="auto" className="min-w-0 flex-1 truncate">
        {entry.label}
      </span>
      {entry.locked ? (
        <>
          <Lock size={11} className="shrink-0 text-foreground/40" aria-hidden="true" />
          <span className="sr-only">{t("dictionary.shared.lockedEntry")}</span>
        </>
      ) : (
        entry.count !== null && (
          <span className="shrink-0 tabular-nums text-foreground/40">{entry.count}</span>
        )
      )}
      <span className="w-3 shrink-0">
        {selected && <Check size={12} className="text-primary" aria-hidden="true" />}
      </span>
    </DropdownMenuItem>
  );
}

export function DictionaryListPicker({
  entries,
  selected,
  onSelect,
}: DictionaryListPickerProps): ReactElement {
  const { t } = useTranslation();
  const selectedLabel = entries.find((entry) => entry.key === selected)?.label;
  const inGroup = (group: PickerEntry["group"]): PickerEntry[] =>
    entries.filter((entry) => entry.group === group);
  const renderEntry = (entry: PickerEntry): ReactElement => (
    <PickerButton
      key={entry.key}
      entry={entry}
      selected={entry.key === selected}
      onSelect={onSelect}
    />
  );

  return (
    <DropdownMenu>
      <Tooltip content={selectedLabel}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={selectedLabel}
            className="me-1 flex h-7 min-w-0 max-w-44 items-center gap-2 rounded-md border border-border/70 bg-card px-2 text-xs text-foreground transition-colors hover:border-border-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 dark:border-white/10 dark:bg-surface-1"
          >
            <span dir="auto" className="min-w-0 truncate">
              {selectedLabel}
            </span>
            <ChevronDown size={12} className="shrink-0 text-foreground/50" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-60 overflow-y-auto rounded-lg p-1"
      >
        {inGroup("top").map(renderEntry)}
        {inGroup("shared").length > 0 && (
          <>
            <p className="px-2 pt-2 pb-1 text-[11px] text-foreground/45">
              {t("dictionary.shared.group")}
            </p>
            {inGroup("shared").map(renderEntry)}
          </>
        )}
        {inGroup("bottom").length > 0 && (
          <>
            <DropdownMenuSeparator />
            {inGroup("bottom").map(renderEntry)}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "lucide-react";
import { Input } from "./input";
import { ModelCard, type ModelCardOption } from "./ModelCardList";
import { getRemoteProviderIcon } from "../../utils/providerIcons";
import { LIST_SEARCH_THRESHOLD } from "../../config/constants";

// Above this count, OpenAICompatiblePanel switches from the plain list to this
// searchable/grouped/virtualized variant.
export const MODEL_SEARCH_THRESHOLD = LIST_SEARCH_THRESHOLD;

const OTHER_GROUP = "__other";
const SELECTED_GROUP = "__selected";

type Row =
  | { type: "header"; key: string; label: string; count: number }
  | { type: "model"; key: string; data: ModelCardOption };

function providerPrefix(value: string): string | null {
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : null;
}

function matchesQuery(model: ModelCardOption, normalizedQuery: string): boolean {
  return (
    model.value.toLowerCase().includes(normalizedQuery) ||
    model.label.toLowerCase().includes(normalizedQuery) ||
    (model.description?.toLowerCase().includes(normalizedQuery) ?? false)
  );
}

// Resolve the provider icon from the "provider/" prefix. Group rows drop the
// prefix from the label (the header already names the provider); the pinned
// "Selected" row keeps the full id so its provider stays identifiable.
function toDisplayOption(model: ModelCardOption, stripPrefix: boolean): ModelCardOption {
  const prefix = providerPrefix(model.value);
  if (!prefix) {
    if (!model.group || model.icon) return model;
    // Vendor names like "Mistral AI" or "Z.AI" → icon slugs like "mistralai".
    const groupSlug = model.group.toLowerCase().replace(/[^a-z0-9]/g, "");
    const { icon, invertInDark } = getRemoteProviderIcon(groupSlug, model.value);
    return { ...model, icon, invertInDark };
  }
  const name = model.value.slice(prefix.length + 1);
  const { icon, invertInDark } = getRemoteProviderIcon(prefix, name);
  const label = (stripPrefix && name) || model.label;
  return { ...model, label, icon, invertInDark };
}

interface SearchableModelListProps {
  models: ModelCardOption[];
  selectedModel: string;
  onModelSelect: (modelId: string) => void;
}

export default function SearchableModelList({
  models,
  selectedModel,
  onModelSelect,
}: SearchableModelListProps) {
  const { t } = useTranslation();
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLowerCase();

  const selectedOption = useMemo(
    () => models.find((m) => m.value === selectedModel) ?? null,
    [models, selectedModel]
  );

  const { rows, matchCount } = useMemo(() => {
    const groups = new Map<string, ModelCardOption[]>();
    const seen = new Set<string>();
    for (const model of models) {
      if (model.value === selectedModel) continue; // pinned separately
      if (seen.has(model.value)) continue;
      if (normalizedQuery && !matchesQuery(model, normalizedQuery)) continue;
      seen.add(model.value);
      const prefix = model.group ?? providerPrefix(model.value);
      const key = prefix ? prefix.replace(/^~/, "").toLowerCase() : OTHER_GROUP;
      const bucket = groups.get(key);
      if (bucket) bucket.push(model);
      else groups.set(key, [model]);
    }

    const sortedKeys = [...groups.keys()].sort((a, b) => {
      if (a === OTHER_GROUP) return 1;
      if (b === OTHER_GROUP) return -1;
      return a.localeCompare(b);
    });

    const result: Row[] = [];
    let matched = 0;
    if (selectedOption) {
      result.push({
        type: "header",
        key: SELECTED_GROUP,
        label: t("reasoning.custom.selectedGroup"),
        count: 1,
      });
      result.push({
        type: "model",
        key: `m:${selectedOption.value}`,
        data: toDisplayOption(selectedOption, false),
      });
    }
    for (const key of sortedKeys) {
      const bucket = groups.get(key)!.sort((a, b) => a.label.localeCompare(b.label));
      result.push({
        type: "header",
        key: `g:${key}`,
        label: key === OTHER_GROUP ? t("reasoning.custom.otherGroup") : key,
        count: bucket.length,
      });
      for (const model of bucket) {
        result.push({ type: "model", key: `m:${model.value}`, data: toDisplayOption(model, true) });
        matched += 1;
      }
    }
    return { rows: result, matchCount: matched };
  }, [models, selectedModel, selectedOption, normalizedQuery, t]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index].type === "header" ? 30 : 40),
    getItemKey: (index) => rows[index].key,
    overscan: 8,
  });

  // Reset scroll + keyboard cursor whenever the filtered result set changes.
  useEffect(() => {
    setActiveIndex(-1);
    virtualizer.scrollToOffset(0);
  }, [normalizedQuery, virtualizer]);

  // Rows also rebuild without a query change (list refetch, selection moving
  // into the pinned group) — indexes shift, so drop the cursor entirely.
  useEffect(() => {
    setActiveIndex(-1);
  }, [models, selectedModel]);

  const moveActive = (direction: 1 | -1) => {
    const step = (from: number) => {
      for (let i = from + direction; i >= 0 && i < rows.length; i += direction) {
        if (rows[i].type === "model") return i;
      }
      return -1;
    };
    const next = step(activeIndex < 0 && direction < 0 ? rows.length : activeIndex);
    if (next >= 0) {
      setActiveIndex(next);
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      const row = rows[activeIndex];
      if (row?.type === "model") {
        event.preventDefault();
        onModelSelect(row.data.value);
      }
    }
  };

  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const activeId = activeRow?.type === "model" ? `${listboxId}-${activeRow.data.value}` : undefined;
  const selectedMatches = !!selectedOption && matchesQuery(selectedOption, normalizedQuery);
  const showEmpty = normalizedQuery.length > 0 && matchCount === 0 && !selectedMatches;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          size={14}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("reasoning.custom.searchPlaceholder")}
          aria-label={t("reasoning.custom.searchPlaceholder")}
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          className="h-9 pl-8 text-sm"
        />
      </div>

      {rows.length > 0 && (
        <div ref={scrollRef} className="overflow-y-auto pr-0.5 max-h-80">
          <div
            id={listboxId}
            role="listbox"
            aria-label={t("reasoning.custom.searchPlaceholder")}
            style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = rows[virtualItem.index];
              const isActive = virtualItem.index === activeIndex;
              return (
                <div
                  key={row.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {row.type === "header" ? (
                    <div className="flex items-center gap-1.5 px-0.5 pt-2 pb-1">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                        {row.label}
                      </span>
                      <span className="text-[11px] text-muted-foreground/40 tabular-nums">
                        {row.count}
                      </span>
                    </div>
                  ) : (
                    <div
                      id={`${listboxId}-${row.data.value}`}
                      role="option"
                      aria-selected={row.data.value === selectedModel}
                      className={`pb-0.5 rounded-md ${isActive ? "ring-1 ring-primary/50" : ""}`}
                    >
                      <ModelCard
                        model={row.data}
                        isSelected={row.data.value === selectedModel}
                        onSelect={onModelSelect}
                        truncateDescription
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showEmpty && (
        <p className="text-xs text-muted-foreground py-3 text-center">
          {t("reasoning.custom.noSearchResults", { query: query.trim() })}
        </p>
      )}
    </div>
  );
}

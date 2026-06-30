import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "lucide-react";
import { Input } from "./input";
import { ModelCard, type ModelCardOption } from "./ModelCardList";
import { getRemoteProviderIcon } from "../../utils/providerIcons";

// Above this count, OpenAICompatiblePanel switches from the plain list to this
// searchable/grouped/virtualized variant. Mirrors LanguageSelector's threshold.
export const MODEL_SEARCH_THRESHOLD = 12;

const OTHER_GROUP = "__other";
const SELECTED_GROUP = "__selected";

type Row =
  | { type: "header"; key: string; label: string; count: number }
  | { type: "model"; key: string; data: ModelCardOption };

function providerPrefix(value: string): string | null {
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : null;
}

// The group header already names the provider, so drop the "provider/" prefix
// from the label and show the provider's icon on the row instead.
function toDisplayOption(model: ModelCardOption): ModelCardOption {
  const prefix = providerPrefix(model.value);
  if (!prefix) return model;
  const { icon, invertInDark } = getRemoteProviderIcon(prefix);
  return { ...model, label: model.value.slice(prefix.length + 1), icon, invertInDark };
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
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLowerCase();

  const selectedOption = useMemo(
    () => models.find((m) => m.value === selectedModel) ?? null,
    [models, selectedModel]
  );

  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, ModelCardOption[]>();
    for (const model of models) {
      if (model.value === selectedModel) continue; // pinned separately
      if (
        normalizedQuery &&
        !model.value.toLowerCase().includes(normalizedQuery) &&
        !model.label.toLowerCase().includes(normalizedQuery) &&
        !(model.description?.toLowerCase().includes(normalizedQuery) ?? false)
      ) {
        continue;
      }
      const prefix = providerPrefix(model.value);
      const key = prefix ? prefix.replace(/^~/, "") : OTHER_GROUP;
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
        data: toDisplayOption(selectedOption),
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
        result.push({ type: "model", key: `m:${model.value}`, data: toDisplayOption(model) });
      }
    }
    return result;
  }, [models, selectedModel, selectedOption, normalizedQuery, t]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index].type === "header" ? 30 : 40),
    overscan: 8,
  });

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
          placeholder={t("reasoning.custom.searchPlaceholder")}
          aria-label={t("reasoning.custom.searchPlaceholder")}
          className="h-9 pl-8 text-sm"
        />
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground py-3 text-center">
          {t("reasoning.custom.noSearchResults", { query: query.trim() })}
        </p>
      ) : (
        <div ref={scrollRef} className="overflow-y-auto pr-0.5 max-h-80">
          <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = rows[virtualItem.index];
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
                    <div className="pb-0.5">
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
    </div>
  );
}

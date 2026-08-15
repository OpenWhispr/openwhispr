import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import registry from "../../config/languageRegistry.json";

const NATIVE_LABELS: Record<string, string> = {
  ar: "العربية",
  de: "Deutsch",
  en: "English",
  es: "Español",
  fr: "Français",
  hi: "हिन्दी",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  pt: "Português",
  ru: "Русский",
  zh: "简体中文",
};

interface LanguageSelectionStepProps {
  selected: string[];
  onChange: (languages: string[]) => void;
  searchPlaceholder: string;
  noResultsLabel: string;
  selectedLabel: string;
}

export default function LanguageSelectionStep({
  selected,
  onChange,
  searchPlaceholder,
  noResultsLabel,
  selectedLabel,
}: LanguageSelectionStepProps) {
  const [query, setQuery] = useState("");
  const languages = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return registry.languages;
    return registry.languages.filter(({ code, label }) =>
      [code, label, NATIVE_LABELS[code]]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(normalized))
    );
  }, [query]);

  const toggle = (code: string) => {
    onChange(
      selected.includes(code) ? selected.filter((item) => item !== code) : [...selected, code]
    );
  };

  return (
    <div className="mx-auto mt-8 w-full max-w-2xl space-y-4">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder}
          className="h-12 w-full rounded-xl border border-border bg-card pl-11 pr-4 text-sm text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
      </label>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label={selectedLabel}>
          {selected.map((code) => {
            const language = registry.languages.find((item) => item.code === code);
            if (!language) return null;
            return (
              <button
                type="button"
                key={code}
                onClick={() => toggle(code)}
                className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/15"
              >
                <span aria-hidden="true">{language.flag}</span>
                {language.label}
                <X className="size-3" />
              </button>
            );
          })}
        </div>
      )}

      <div className="max-h-80 overflow-y-auto rounded-2xl border border-border bg-card p-2 shadow-sm">
        {languages.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{noResultsLabel}</p>
        ) : (
          languages.map((language) => {
            const checked = selected.includes(language.code);
            return (
              <button
                key={language.code}
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggle(language.code)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                  checked ? "bg-primary/8" : "hover:bg-muted"
                }`}
              >
                <span className="text-lg" aria-hidden="true">
                  {language.flag}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {language.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground" dir="auto">
                    {NATIVE_LABELS[language.code] ?? language.label}
                  </span>
                </span>
                <span
                  className={`flex size-5 items-center justify-center rounded-md border ${
                    checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background"
                  }`}
                  aria-hidden="true"
                >
                  {checked && <Check className="size-3.5" />}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

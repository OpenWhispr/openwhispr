import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import {
  displayOnboardingLanguageLabel,
  getOnboardingLanguageByCode,
  getOnboardingLanguageNativeLabel,
  getOnboardingLanguageOptions,
} from "./languageOptions";

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
  const languages = useMemo(() => getOnboardingLanguageOptions(query, selected), [query, selected]);

  const toggle = (code: string) => {
    onChange(
      selected.includes(code) ? selected.filter((item) => item !== code) : [...selected, code]
    );
  };

  return (
    <div className="mx-auto mt-6 w-full max-w-[26.25rem] space-y-2.5">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-neutral-400" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder}
          className="onboarding-light-input onboarding-light-input-bordered h-10 w-full rounded-full! border border-neutral-200 bg-white pl-10 pr-4 text-sm text-neutral-950 shadow-none! outline-none placeholder:text-neutral-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
        />
      </label>

      {selected.length > 0 && (
        <div className="flex min-h-8 flex-wrap gap-2" aria-label={selectedLabel}>
          {selected.map((code) => {
            const language = getOnboardingLanguageByCode(code);
            if (!language) return null;
            return (
              <button
                type="button"
                key={code}
                onClick={() => toggle(code)}
                className="inline-flex h-8 items-center gap-2 rounded-full border border-neutral-200 bg-white px-4 text-sm font-normal text-neutral-950 hover:bg-neutral-50"
              >
                {displayOnboardingLanguageLabel(language)}
                <X className="size-4" strokeWidth={1.8} />
              </button>
            );
          })}
        </div>
      )}

      <div className="max-h-[15.5rem] overflow-y-auto rounded-2xl border border-neutral-200 bg-white px-3">
        {languages.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-neutral-500">{noResultsLabel}</p>
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
                className="flex h-12 w-full items-center gap-3 border-b border-neutral-200 text-left transition-colors last:border-b-0 hover:bg-neutral-50"
              >
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded-[0.3rem] border ${
                    checked
                      ? "border-blue-500 bg-blue-500 text-white"
                      : "border-neutral-200 bg-white"
                  }`}
                  aria-hidden="true"
                >
                  {checked && <Check className="size-3.5" strokeWidth={2.5} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-neutral-950">
                    {displayOnboardingLanguageLabel(language)}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-neutral-500" dir="auto">
                    {getOnboardingLanguageNativeLabel(language)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

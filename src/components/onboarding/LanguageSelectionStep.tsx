import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import OnboardingList from "./OnboardingList";
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
    <div className="mx-auto mt-6 flex min-h-0 w-full max-w-[33.75rem] flex-1 flex-col gap-2.5">
      {/* Figma: Onboarding / Frame 25 — pad 12 16, gap 10, radius 66 (pill),
          24px icon and 18/140% text, both in text-tertiary. Height hugs the
          content rather than being pinned, which is why there's no h-*. */}
      <label className="relative block">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2 text-[var(--onboarding-text-tertiary)]"
          strokeWidth={2}
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder}
          /* pl = 16 pad + 24 icon + 10 gap = 50px */
          className="onboarding-light-input onboarding-light-input-bordered w-full rounded-full! border border-[var(--onboarding-control-border)] bg-white py-3 pl-[3.125rem] pr-4 text-[1.125rem] leading-[1.4] text-[var(--onboarding-text-primary)] shadow-none! outline-none placeholder:text-[var(--onboarding-text-tertiary)] focus:border-[var(--onboarding-accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--onboarding-accent)_15%,transparent)]"
        />
      </label>

      {selected.length > 0 && (
        <div className="flex min-h-8 flex-wrap gap-2" aria-label={selectedLabel}>
          {selected.map((code) => {
            const language = getOnboardingLanguageByCode(code);
            if (!language) return null;
            return (
              // Figma: Onboarding / Frame 38 — gap 7, pad 10 20, radius 38,
              // 14/140% medium, 20px close glyph at 1.667 stroke.
              <button
                type="button"
                key={code}
                onClick={() => toggle(code)}
                className="onboarding-pressable inline-flex items-center gap-[7px] rounded-full border border-[var(--onboarding-control-border)] bg-white px-5 py-2.5 text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)] hover:bg-neutral-50"
              >
                {displayOnboardingLanguageLabel(language)}
                <X className="size-5 shrink-0" strokeWidth={1.667} />
              </button>
            );
          })}
        </div>
      )}

      {/* Figma: Onboarding / Frame 37. OnboardingList owns the surface, the
          scrollbar and the single shared hover slab; rows just carry
          .onboarding-list-row. max-h shows 5 rows, matching the Figma frame. */}
      <OnboardingList className="min-h-0 flex-1">
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
                className="onboarding-list-row w-full text-left"
              >
                {/* The control keeps its light stroke when checked — the spec's
                    asset carries both the fill and the #E3E3E3 border. */}
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-[5.5px] border border-[var(--onboarding-control-border)] ${
                    checked ? "bg-[var(--onboarding-accent)] text-white" : "bg-white"
                  }`}
                  aria-hidden="true"
                >
                  {checked && <Check className="size-4" strokeWidth={1.17} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-base font-medium leading-[1.4] text-[var(--onboarding-text-primary)]">
                    {displayOnboardingLanguageLabel(language)}
                  </span>
                  <span
                    className="truncate text-sm font-normal leading-[1.4] text-[var(--onboarding-text-secondary)]"
                    dir="auto"
                  >
                    {getOnboardingLanguageNativeLabel(language)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </OnboardingList>
    </div>
  );
}

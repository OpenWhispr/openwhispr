import { useId } from "react";
import { Check } from "lucide-react";
import { UI_LANGUAGE_OPTIONS, type UiLanguage } from "../../config/uiLanguages";
import OnboardingList from "./OnboardingList";

interface InterfaceLanguageStepProps {
  value: string;
  onChange: (language: UiLanguage) => void;
  label: string;
}

export default function InterfaceLanguageStep({
  value,
  onChange,
  label,
}: InterfaceLanguageStepProps) {
  const groupName = useId();

  return (
    <OnboardingList className="mx-auto mt-5 min-h-0 w-full max-w-md flex-1">
      <div role="radiogroup" aria-label={label}>
        {UI_LANGUAGE_OPTIONS.map((language) => {
          const selected = language.value === value;
          return (
            <label key={language.value} className="onboarding-list-row w-full text-left">
              <input
                type="radio"
                name={groupName}
                value={language.value}
                checked={selected}
                onChange={() => onChange(language.value)}
                className="peer sr-only"
              />
              <span className="text-xl leading-none" aria-hidden="true">
                {language.flag}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)]"
                dir="auto"
              >
                {language.label}
              </span>
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--onboarding-accent)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--onboarding-surface)] ${
                  selected
                    ? "border-[var(--onboarding-accent)] bg-[var(--onboarding-accent)] text-[var(--onboarding-accent-foreground)]"
                    : "border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)]"
                }`}
                aria-hidden="true"
              >
                {selected && <Check className="size-3.5" strokeWidth={1.7} />}
              </span>
            </label>
          );
        })}
      </div>
    </OnboardingList>
  );
}

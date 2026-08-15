import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { OnboardingStepHeader } from "./OnboardingShell";
import { USE_CASE_OPTIONS } from "./useCases";

interface UseCaseStepProps {
  useCases: string[];
  onUseCasesChange: (useCases: string[]) => void;
  note: string;
  onNoteChange: (note: string) => void;
}

export default function UseCaseStep({
  useCases,
  onUseCasesChange,
  note,
  onNoteChange,
}: UseCaseStepProps) {
  const { t } = useTranslation();

  const toggleUseCase = (id: string) => {
    onUseCasesChange(
      useCases.includes(id) ? useCases.filter((item) => item !== id) : [...useCases, id]
    );
  };

  return (
    <div className="min-h-full w-full">
      <OnboardingStepHeader
        title={t("onboarding.useCase.title")}
        titleLines={[t("onboarding.useCase.titleLineOne"), t("onboarding.useCase.titleLineTwo")]}
        description={t("onboarding.useCase.description")}
      />

      <div className="mx-auto mt-8 w-full max-w-[26.25rem] space-y-2">
        {USE_CASE_OPTIONS.map(({ id }) => {
          const selected = useCases.includes(id);
          return (
            <button
              key={id}
              type="button"
              role="checkbox"
              aria-checked={selected}
              onClick={() => toggleUseCase(id)}
              className={`flex h-14 w-full items-center gap-3 rounded-xl border px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20 ${
                selected
                  ? "border-blue-500 bg-blue-50/50"
                  : "border-neutral-200 bg-white hover:bg-neutral-50"
              }`}
            >
              <span
                className={`flex size-4 shrink-0 items-center justify-center rounded-[0.25rem] border ${
                  selected
                    ? "border-blue-500 bg-blue-500 text-white"
                    : "border-neutral-300 bg-white"
                }`}
                aria-hidden="true"
              >
                {selected && <Check className="size-3" strokeWidth={2.7} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-normal text-neutral-950">
                  {t(`onboarding.useCase.options.${id}.title`)}
                </span>
                <span className="mt-0.5 block truncate text-xs text-neutral-500">
                  {t(`onboarding.useCase.options.${id}.description`)}
                </span>
              </span>
            </button>
          );
        })}

        <label>
          <span className="sr-only">{t("onboarding.useCase.noteLabel")}</span>
          <input
            type="text"
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder={t("onboarding.useCase.notePlaceholder")}
            className="onboarding-light-input onboarding-light-input-bordered h-9 w-full rounded-xl! border border-neutral-200 bg-white px-3 text-xs text-neutral-950 shadow-none! outline-none placeholder:text-neutral-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
          />
        </label>
      </div>
    </div>
  );
}

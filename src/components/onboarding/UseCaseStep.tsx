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
    // h-full + a scrolling body: the shell never scrolls, so the seven cards
    // have to absorb a short window themselves instead of spilling past the
    // footer.
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="shrink-0">
        <OnboardingStepHeader
          title={t("onboarding.useCase.title")}
          titleLines={[t("onboarding.useCase.titleLineOne"), t("onboarding.useCase.titleLineTwo")]}
          description={t("onboarding.useCase.description")}
        />
      </div>

      {/* Figma: Onboarding / Frame 50 — 527 wide, gap 10. Each row is a
          radius-12 white card with a 14 16 pad, 12 gap and a 16px control;
          the card hugs its text instead of being pinned to a height.
          px-1/py-1 leaves room for the focus ring inside the scroll box. */}
      <div className="onboarding-shell-scroll mx-auto mt-5 flex w-full max-w-md min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1 py-1">
        {USE_CASE_OPTIONS.map(({ id }) => {
          const selected = useCases.includes(id);
          return (
            <button
              key={id}
              type="button"
              role="checkbox"
              aria-checked={selected}
              onClick={() => toggleUseCase(id)}
              // Figma: Frame 36 — the selected row is the same card as the
              // unselected one. Only the control changes; the surface keeps its
              // white fill and #E3E3E3 stroke.
              className="flex w-full shrink-0 items-center gap-2.5 overflow-hidden rounded-xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--onboarding-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_20%,transparent)]"
            >
              {/* Unchecked: #00000033 hairline. Checked: the spec's asset —
                  accent fill, no stroke, 1px white tick with round joins. */}
              {selected ? (
                <svg
                  className="size-4 shrink-0"
                  viewBox="0 0 16 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <rect width="16" height="16" rx="4" fill="var(--onboarding-accent)" />
                  <path
                    d="M12 5L6.5 10.5L4 8"
                    stroke="white"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <span
                  className="size-4 shrink-0 rounded border border-[var(--onboarding-control-border)]"
                  aria-hidden="true"
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-normal leading-[1.4] text-[var(--onboarding-text-primary)]">
                  {t(`onboarding.useCase.options.${id}.title`)}
                </span>
                <span className="truncate text-xs font-normal leading-[1.4] text-[var(--onboarding-text-secondary)]">
                  {t(`onboarding.useCase.options.${id}.description`)}
                </span>
              </span>
            </button>
          );
        })}

        {/* Figma: Frame 37 — same card shell as the rows, pad 12, 14/140%
            placeholder in text-tertiary. */}
        <label className="block shrink-0">
          <span className="sr-only">{t("onboarding.useCase.noteLabel")}</span>
          <input
            type="text"
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder={t("onboarding.useCase.notePlaceholder")}
            className="onboarding-light-input onboarding-light-input-bordered w-full rounded-xl! border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] p-2.5 text-sm font-normal leading-[1.4] text-[var(--onboarding-text-primary)] shadow-none! outline-none placeholder:text-[var(--onboarding-text-tertiary)] focus:border-[var(--onboarding-accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--onboarding-accent)_15%,transparent)]"
          />
        </label>
      </div>
    </div>
  );
}

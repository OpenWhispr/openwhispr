import { useTranslation } from "react-i18next";
import { Textarea } from "../ui/textarea";
import OptionCard from "../ui/OptionCard";
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
    onUseCasesChange(useCases.includes(id) ? useCases.filter((c) => c !== id) : [...useCases, id]);
  };

  return (
    <div className="space-y-4">
      <div className="text-center space-y-1">
        <h2 className="text-lg font-semibold text-foreground tracking-tight">
          {t("onboarding.useCase.title")}
        </h2>
        <p className="text-xs text-muted-foreground leading-relaxed max-w-md mx-auto">
          {t("onboarding.useCase.description")}
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("onboarding.useCase.selectHint")}
        </p>
        {USE_CASE_OPTIONS.map(({ id, icon }) => (
          <OptionCard
            key={id}
            icon={icon}
            title={t(`onboarding.useCase.options.${id}.title`)}
            description={t(`onboarding.useCase.options.${id}.description`)}
            selected={useCases.includes(id)}
            onSelect={() => toggleUseCase(id)}
          />
        ))}
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-muted-foreground">
          {t("onboarding.useCase.noteLabel")}
        </label>
        <Textarea
          rows={2}
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder={t("onboarding.useCase.notePlaceholder")}
          className="text-sm resize-none"
        />
      </div>
    </div>
  );
}

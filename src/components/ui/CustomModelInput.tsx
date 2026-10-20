import { useTranslation } from "react-i18next";
import { Input } from "./input";

interface CustomModelInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  hint?: string;
  /** Called on blur and Enter, for callers that save a finished id rather than every keystroke. */
  onCommit?: (value: string) => void;
}

export default function CustomModelInput({
  value,
  onChange,
  placeholder,
  label,
  hint,
  onCommit,
}: CustomModelInputProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-1.5 pt-2">
      <label className="text-xs font-medium text-muted-foreground">
        {label || t("reasoning.enterprise.customModelId", { defaultValue: "Custom Model ID" })}
      </label>
      <Input
        dir="ltr"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit ? (e) => onCommit(e.target.value) : undefined}
        onKeyDown={
          onCommit
            ? (e) => {
                if (e.key === "Enter") onCommit(e.currentTarget.value);
              }
            : undefined
        }
        placeholder={
          placeholder ||
          t("reasoning.enterprise.customModelPlaceholder", {
            defaultValue: "Enter model ID or deployment name",
          })
        }
        className="text-sm font-mono"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

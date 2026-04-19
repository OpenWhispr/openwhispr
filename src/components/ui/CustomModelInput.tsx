import { useTranslation } from "react-i18next";
import { Input } from "./input";

interface CustomModelInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function CustomModelInput({ value, onChange, placeholder }: CustomModelInputProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-1.5 pt-2">
      <label className="text-xs font-medium text-muted-foreground">
        {t("reasoning.enterprise.customModelId", { defaultValue: "Custom Model ID" })}
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          placeholder ||
          t("reasoning.enterprise.customModelPlaceholder", {
            defaultValue: "Enter model ID or deployment name",
          })
        }
        className="text-sm font-mono"
      />
    </div>
  );
}

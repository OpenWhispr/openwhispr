import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "../icons";
import { Input } from "../ui/input";

interface SkillSearchInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function SkillSearchInput({ value, onChange }: SkillSearchInputProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <Search
        size={13}
        className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/70"
      />
      <Input
        type="search"
        dir="auto"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // Esc clears a search first, so it leaves the screen only once the box is empty.
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !value || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          onChange("");
        }}
        placeholder={t("skills.pane.search")}
        aria-label={t("skills.pane.search")}
        className="h-8 w-44 ps-8 pe-3 text-xs rounded-lg"
      />
    </div>
  );
}

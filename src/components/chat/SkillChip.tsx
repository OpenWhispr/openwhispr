import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { X } from "../icons";
import { SkillIcon } from "../skills/SkillIcon";

/** The skill a chat uses, shown in its composer; × takes it off the chat. */
export function SkillChip({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  // The icon drops in once as the chip arrives; it never plays on its own first render.
  const [playKey, setPlayKey] = useState(0);
  useEffect(() => setPlayKey(1), []);

  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-card ps-1 pe-1 text-xs text-foreground dark:border-white/10">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <SkillIcon size={12} playKey={playKey} />
      </span>
      <span dir="auto" className="min-w-0 truncate">
        {name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("skills.chat.chipRemove", { name })}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 hover:bg-foreground/8 hover:text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
      >
        <X size={11} />
      </button>
    </span>
  );
}

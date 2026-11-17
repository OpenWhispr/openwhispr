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
    <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-default bg-surface-primary ps-1 pe-1 text-xs text-primary">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-solid/10 text-brand-solid">
        <SkillIcon size={12} playKey={playKey} />
      </span>
      <span dir="auto" className="min-w-0 truncate">
        {name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("skills.chat.chipRemove", { name })}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-secondary/70 hover:bg-text-primary/8 hover:text-primary outline-none focus-visible:ring-1 focus-visible:ring-focus/30"
      >
        <X size={11} />
      </button>
    </span>
  );
}

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Upload, Users } from "../icons";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { CARD_SURFACE_CLASS } from "../ui/surfaces";

interface SharedListEmptyProps {
  listName: string;
  memberCount: number;
  // Opens the bulk import, aimed at this list.
  onImport: () => void;
  onShareFromPersonal: () => void;
}

/** A team list the member can use that has no words yet. */
export function SharedListEmpty({
  listName,
  memberCount,
  onImport,
  onShareFromPersonal,
}: SharedListEmptyProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={cn(CARD_SURFACE_CLASS, "rounded-lg px-4 py-4 shadow-sm")}>
      <h3 dir="auto" className="text-sm font-medium text-foreground">
        {t("dictionary.shared.emptyList", { list: listName })}
      </h3>
      <p dir="auto" className="mt-1.5 max-w-xl text-xs leading-relaxed text-foreground/55">
        {t("dictionary.shared.empty.body", { list: listName, count: memberCount })}
      </p>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onImport}>
          <Upload size={13} aria-hidden="true" />
          {t("dictionary.shared.empty.import")}
        </Button>
        <Button size="sm" variant="outline" onClick={onShareFromPersonal}>
          <Users size={13} aria-hidden="true" />
          {t("dictionary.shared.empty.shareFromPersonal")}
        </Button>
      </div>
    </div>
  );
}

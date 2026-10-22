import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";

/** The pill beside every connector's name while connectors are in beta. */
export function BetaBadge(): ReactElement {
  const { t } = useTranslation();
  return (
    <Badge className="px-1.5 py-0 text-[10px] font-medium leading-4">{t("connectors.beta")}</Badge>
  );
}

import type { JSX } from "react";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ManagedEnterpriseLocalModelSelection } from "../../types/enterpriseIdentity";
import {
  getParakeetModelInfo,
  getWhisperModelInfo,
  modelRegistry,
} from "../../models/ModelRegistry";
import { ProviderIcon } from "../ui/ProviderIcon";

function displayName(
  selection: ManagedEnterpriseLocalModelSelection | null,
  waiting: string
): string {
  if (!selection) return waiting;
  if (selection.provider === "whisper") {
    return getWhisperModelInfo(selection.model)?.name ?? selection.model;
  }
  if (selection.provider === "nvidia") {
    return getParakeetModelInfo(selection.model)?.name ?? selection.model;
  }
  return modelRegistry.getModel(selection.model)?.model.name ?? selection.model;
}

export function ManagedLocalModelNotice({
  selection,
}: {
  selection: ManagedEnterpriseLocalModelSelection | null;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {selection ? (
            <ProviderIcon
              provider={selection.provider === "whisper" ? "openai" : selection.provider}
              className="size-4"
            />
          ) : (
            <Lock className="size-4" aria-hidden="true" />
          )}
        </span>
        <div>
          <p className="text-sm font-medium">
            {displayName(selection, t("managedLocalModels.notice.waiting"))}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("managedLocalModels.notice.managedDescription")}
          </p>
        </div>
      </div>
    </div>
  );
}

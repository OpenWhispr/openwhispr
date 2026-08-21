import { Lock } from "lucide-react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import {
  getParakeetModelInfo,
  getWhisperModelInfo,
  modelRegistry,
} from "../../models/ModelRegistry";
import { ProviderIcon } from "../ui/ProviderIcon";
import type { ManagedEnterpriseLocalModelSelection } from "../../types/enterpriseIdentity";

function modelName(
  selection: ManagedEnterpriseLocalModelSelection | null,
  waitingLabel: string
): string {
  if (!selection) return waitingLabel;
  if (selection.provider === "whisper") {
    return getWhisperModelInfo(selection.modelId)?.name ?? selection.modelId;
  }
  if (selection.provider === "nvidia") {
    return getParakeetModelInfo(selection.modelId)?.name ?? selection.modelId;
  }
  return modelRegistry.getModel(selection.modelId)?.model.name ?? selection.modelId;
}

export function ManagedLocalModelNotice({
  selection,
}: {
  selection: ManagedEnterpriseLocalModelSelection | null;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {selection ? (
            <ProviderIcon
              provider={selection.provider === "whisper" ? "openai" : selection.provider}
              className="size-5"
            />
          ) : (
            <Lock className="size-4" />
          )}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {modelName(selection, t("managedLocalModels.notice.waiting"))}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("managedLocalModels.notice.managedDescription")}
          </p>
        </div>
      </div>
    </div>
  );
}

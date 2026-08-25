import type { JSX } from "react";
import { AlertCircle, Check, Download, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "../ui/ProviderIcon";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { ManagedSetupBlockedActions } from "./ManagedSetupBlockedActions";
import type { ManagedLocalModelCategory } from "./managedLocalModels";

export type ManagedSetupRowStatus = "installed" | "downloading" | "missing" | "blocked" | "error";

export interface ManagedSetupDisplayRow {
  key: string;
  category: ManagedLocalModelCategory;
  provider: string;
  model: string;
  label: string;
  size?: string;
  status: ManagedSetupRowStatus;
  progress?: number;
  disabledReason?: string;
  errorMessage?: string;
}

export interface EnterpriseModelSetupStepProps {
  rows: ManagedSetupDisplayRow[];
  busy: boolean;
  ready: boolean;
  errorMessage: string | null;
  onSelect: (row: ManagedSetupDisplayRow) => void;
  onRetry: () => void;
  onSignOut: () => void;
}

function RowStatus({ row }: { row: ManagedSetupDisplayRow }): JSX.Element {
  const { t } = useTranslation();
  if (row.status === "installed") {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600">
        <Check className="size-3.5" aria-hidden="true" />
        {t("onboarding.managedLocal.status.installed")}
      </span>
    );
  }
  if (row.status === "downloading") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {Math.round(row.progress ?? 0)}%
      </span>
    );
  }
  if (row.status === "error") {
    return <span className="text-xs text-destructive">{row.errorMessage}</span>;
  }
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Download className="size-3.5" aria-hidden="true" />
      {t("common.download")}
    </span>
  );
}

function preventRecoveryDismiss(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

export function EnterpriseModelSetupStep({
  rows,
  busy,
  ready,
  errorMessage,
  onSelect,
  onRetry,
  onSignOut,
}: EnterpriseModelSetupStepProps): JSX.Element {
  const { t } = useTranslation();
  if (errorMessage) {
    return (
      <Dialog open onOpenChange={() => {}}>
        <DialogContent
          hideClose
          className="max-w-lg border-destructive/30 text-center"
          onEscapeKeyDown={preventRecoveryDismiss}
          onPointerDownOutside={preventRecoveryDismiss}
          onFocusOutside={preventRecoveryDismiss}
        >
          <AlertCircle className="mx-auto size-6 text-destructive" aria-hidden="true" />
          <DialogHeader className="text-center sm:text-center">
            <DialogTitle>{t("onboarding.managedLocal.recovery.title")}</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <ManagedSetupBlockedActions onRetry={onRetry} onSignOut={onSignOut} />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <section className="mx-auto w-full max-w-xl" aria-busy={busy}>
      <div className="space-y-2">
        {rows.map((row) => {
          const disabled = row.status === "blocked" || row.status === "downloading";
          return (
            <button
              key={row.key}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(row)}
              className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ProviderIcon
                provider={row.provider === "whisper" ? "openai" : row.provider}
                className="size-5 shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{row.label}</span>
                {row.size ? (
                  <span className="block text-xs text-muted-foreground">{row.size}</span>
                ) : null}
                {row.disabledReason ? (
                  <span className="block text-xs text-destructive">{row.disabledReason}</span>
                ) : null}
              </span>
              <RowStatus row={row} />
            </button>
          );
        })}
      </div>
      <p
        role="status"
        aria-live="polite"
        className="mt-3 text-center text-xs text-muted-foreground"
      >
        {busy
          ? t("onboarding.managedLocal.status.preparing")
          : ready
            ? t("onboarding.managedLocal.status.ready")
            : t("onboarding.managedLocal.status.choose")}
      </p>
    </section>
  );
}

export default EnterpriseModelSetupStep;

import type { TFunction } from "i18next";
import type { TechnicalErrorDetailsData, ToastActionConfig } from "../components/ui/useToast";
import { SELF_HOSTED_NAME, isProviderSettingsTarget } from "../helpers/providerHttpErrors.js";

export type ProviderSettingsTarget = "speechToText" | "llms";

interface DescribableError {
  message?: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  settingsTarget?: string;
  technicalDetails?: TechnicalErrorDetailsData;
}

export interface ProviderErrorDescription {
  description: string;
  technicalDetails?: TechnicalErrorDetailsData;
  settingsTarget?: ProviderSettingsTarget;
}

/** One rendering of a (possibly classified) error for every surface. */
export function describeProviderError(error: unknown, t: TFunction): ProviderErrorDescription {
  if (typeof error === "string") return { description: error };
  const source = (error ?? {}) as DescribableError;
  const description = source.messageKey
    ? String(t(source.messageKey, source.messageParams))
    : source.message || "";
  const settingsTarget = isProviderSettingsTarget(source.settingsTarget)
    ? (source.settingsTarget as ProviderSettingsTarget)
    : undefined;
  return {
    description,
    ...(source.technicalDetails ? { technicalDetails: source.technicalDetails } : {}),
    ...(settingsTarget ? { settingsTarget } : {}),
  };
}

export function formatProviderErrorDetails(
  details: TechnicalErrorDetailsData,
  t: TFunction
): string {
  const isProvider = Boolean(details.provider);
  const provider =
    details.provider === SELF_HOSTED_NAME
      ? t("settingsPage.aiModels.modes.selfHosted")
      : details.provider;
  return [
    provider ? `${t("providerErrors.details.provider")}: ${provider}` : "",
    details.status !== undefined
      ? `${t("reasoning.enterprise.technicalDetails.httpStatus")}: ${details.status}`
      : "",
    details.exceptionType
      ? `${t("reasoning.enterprise.technicalDetails.awsException")}: ${details.exceptionType}`
      : "",
    details.requestId
      ? `${t(
          isProvider
            ? "providerErrors.details.requestId"
            : "reasoning.enterprise.technicalDetails.awsRequestId"
        )}: ${details.requestId}`
      : "",
    details.underlyingError
      ? `${t("reasoning.enterprise.technicalDetails.underlyingError")}: ${details.underlyingError}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function openProviderSettings(target: ProviderSettingsTarget): void {
  void window.electronAPI?.openSettingsSection?.(target);
}

/**
 * Open Settings (fixable errors) and an icon-only Copy details for a toast or
 * dictation card. `isCurrent` lets a superseded card ignore a late click.
 */
export function providerErrorActions(
  error: { settingsTarget?: string; technicalDetails?: TechnicalErrorDetailsData },
  t: TFunction,
  isCurrent: () => boolean = () => true
): ToastActionConfig[] {
  const actions: ToastActionConfig[] = [];
  const { settingsTarget, technicalDetails } = error;
  if (isProviderSettingsTarget(settingsTarget)) {
    actions.push({
      label: t("providerErrors.openSettings"),
      icon: "settings",
      onClick: () => openProviderSettings(settingsTarget as ProviderSettingsTarget),
    });
  }
  if (technicalDetails) {
    actions.push({
      label: t("providerErrors.copyDetails"),
      icon: "copy",
      iconOnly: true,
      dismissOnClick: false,
      feedback: {
        successLabel: t("common.copied"),
        failureLabel: t("hooks.audioRecording.pastePermission.copyFailed"),
      },
      onClick: async () => {
        if (!isCurrent()) return;
        let copied = false;
        try {
          const result = await window.electronAPI?.writeClipboard?.(
            formatProviderErrorDetails(technicalDetails, t)
          );
          copied = result?.success === true;
        } catch {
          copied = false;
        }
        if (isCurrent()) return copied;
      },
    });
  }
  return actions;
}

/** Description and actions for a standard toast reporting a (possibly classified) error. */
export function providerErrorToastProps(
  error: unknown,
  t: TFunction
): { description: string; actions?: ToastActionConfig[] } {
  const { description, technicalDetails, settingsTarget } = describeProviderError(error, t);
  const actions = providerErrorActions({ settingsTarget, technicalDetails }, t);
  return { description, ...(actions.length ? { actions } : {}) };
}

import { COMPOSE_TARGETS } from "../helpers/connectors/emailCompose";
import type { MicrosoftCalendarAccount } from "../types/calendar";
import type { ConnectorStatus } from "../types/connectors";

// "gmail" is the Gmail web compose link; "gmailSend" is the Gmail connector's
// approval card. Main's email connector only ever sees COMPOSE_TARGETS.
export const EMAIL_DRAFT_TARGETS = [...COMPOSE_TARGETS, "gmailSend"] as const;
export const EMAIL_DRAFT_TARGET_SETTINGS = ["auto", ...EMAIL_DRAFT_TARGETS] as const;

export type ComposeTarget = (typeof COMPOSE_TARGETS)[number];
export type EmailDraftTarget = (typeof EMAIL_DRAFT_TARGETS)[number];
export type EmailDraftTargetSetting = (typeof EMAIL_DRAFT_TARGET_SETTINGS)[number];

export type GmailSendStatus = "connected" | "reconnect_needed" | "disconnected";

/** The Gmail connector's login as target resolution sees it. */
export function gmailSendStatus(status: ConnectorStatus | undefined): GmailSendStatus {
  if (!status?.connected || status.configured === false) return "disconnected";
  return status.needsReconnect ? "reconnect_needed" : "connected";
}

// Microsoft's fixed tenant for every consumer (outlook.com, hotmail) account.
const PERSONAL_MICROSOFT_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

// Accounts connected before the tenant was stored fall back to the domain.
// Consumer accounts live on these brands under country domains too
// (hotmail.de, outlook.fr, live.co.uk, outlook.com.br).
const PERSONAL_MICROSOFT_DOMAIN =
  /^(?:outlook|hotmail|live|msn|windowslive|passport)\.(?:com|net|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;

function isPersonalMicrosoftAccount({ email, tenantId }: MicrosoftCalendarAccount): boolean {
  if (tenantId) return tenantId === PERSONAL_MICROSOFT_TENANT_ID;
  return PERSONAL_MICROSOFT_DOMAIN.test(email.split("@")[1]?.toLowerCase() ?? "");
}

export function normalizeEmailDraftTarget(value: string): EmailDraftTargetSetting {
  return (EMAIL_DRAFT_TARGET_SETTINGS as readonly string[]).includes(value)
    ? (value as EmailDraftTargetSetting)
    : "auto";
}

export function resolveEmailDraftTarget(context: {
  emailDraftTarget: string;
  gcalConnected: boolean;
  mcalAccounts: MicrosoftCalendarAccount[];
  gmailStatus?: GmailSendStatus;
}): EmailDraftTarget {
  const setting = normalizeEmailDraftTarget(context.emailDraftTarget);
  if (setting !== "auto" && setting !== "gmailSend") return setting;
  // A login that needs reconnecting still resolves to Gmail, so the tool
  // says "reconnect Gmail" instead of quietly opening a compose window. A
  // stored gmailSend whose login was removed resolves as Automatic.
  if (context.gmailStatus === "connected" || context.gmailStatus === "reconnect_needed") {
    return "gmailSend";
  }
  if (context.gcalConnected) return "gmail";
  if (context.mcalAccounts.some((account) => !isPersonalMicrosoftAccount(account))) {
    return "outlookWork";
  }
  return context.mcalAccounts.length > 0 ? "outlookPersonal" : "mailto";
}

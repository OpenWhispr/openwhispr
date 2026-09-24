export const EMAIL_DRAFT_TARGETS = ["gmail", "outlookWork", "outlookPersonal", "mailto"] as const;

export type EmailDraftTarget = (typeof EMAIL_DRAFT_TARGETS)[number];
export type EmailDraftTargetSetting = EmailDraftTarget | "auto";

const PERSONAL_MICROSOFT_DOMAINS = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

export function resolveEmailDraftTarget(
  setting: string,
  context: { gcalConnected: boolean; mcalAccountEmails: string[] }
): EmailDraftTarget {
  if ((EMAIL_DRAFT_TARGETS as readonly string[]).includes(setting)) {
    return setting as EmailDraftTarget;
  }
  if (context.gcalConnected) return "gmail";
  const microsoftEmail = context.mcalAccountEmails[0];
  if (microsoftEmail) {
    const domain = microsoftEmail.split("@")[1]?.toLowerCase() ?? "";
    return PERSONAL_MICROSOFT_DOMAINS.has(domain) ? "outlookPersonal" : "outlookWork";
  }
  return "mailto";
}

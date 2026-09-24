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
  // If any account is a work account (non-personal domain), use Outlook work
  for (const email of context.mcalAccountEmails) {
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    if (!PERSONAL_MICROSOFT_DOMAINS.has(domain)) {
      return "outlookWork";
    }
  }
  // All accounts are personal, or list is empty
  if (context.mcalAccountEmails.length > 0) {
    return "outlookPersonal";
  }
  return "mailto";
}

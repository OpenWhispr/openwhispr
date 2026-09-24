export const EMAIL_DRAFT_TARGETS = ["gmail", "outlookWork", "outlookPersonal", "mailto"] as const;

export type EmailDraftTarget = (typeof EMAIL_DRAFT_TARGETS)[number];
export type EmailDraftTargetSetting = EmailDraftTarget | "auto";

// Consumer Microsoft accounts live on these brands under country domains too
// (hotmail.de, outlook.fr, live.co.uk, outlook.com.br).
const PERSONAL_MICROSOFT_DOMAIN =
  /^(?:outlook|hotmail|live|msn|windowslive|passport)\.(?:com|net|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;

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
    if (!PERSONAL_MICROSOFT_DOMAIN.test(domain)) {
      return "outlookWork";
    }
  }
  // All accounts are personal, or list is empty
  if (context.mcalAccountEmails.length > 0) {
    return "outlookPersonal";
  }
  return "mailto";
}

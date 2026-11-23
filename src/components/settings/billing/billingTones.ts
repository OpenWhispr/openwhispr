export type BillingTone = "neutral" | "info" | "warning" | "destructive";

const BADGE_TONES: Record<BillingTone, string> = {
  neutral: "bg-surface-3 text-muted-foreground",
  info: "bg-primary/10 text-primary",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

const BANNER_TONES: Record<BillingTone, string> = {
  neutral: "bg-surface-3",
  info: "bg-primary/10",
  warning: "bg-warning/10",
  destructive: "bg-destructive/10",
};

const TITLE_TONES: Record<BillingTone, string> = {
  neutral: "text-foreground",
  info: "text-primary",
  warning: "text-warning",
  destructive: "text-destructive",
};

export function badgeToneClass(tone: BillingTone): string {
  return BADGE_TONES[tone];
}

export function bannerToneClass(tone: BillingTone): string {
  return BANNER_TONES[tone];
}

export function titleToneClass(tone: BillingTone): string {
  return TITLE_TONES[tone];
}

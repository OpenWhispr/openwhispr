import type { TFunction } from "i18next";
import type { ToastProps } from "../ui/useToast";
import type {
  SkillIssue,
  SkillProblemCode,
  SkillWarningCode,
  SkillWriteError,
} from "../../types/skills";

/** The library's cap on a skill's files (SKILL_LIMITS.maxBytes), checked before any is read. */
export const MAX_SKILL_BYTES = 25 * 1024 * 1024;

/** The starter skills shipped in src/helpers/skills/recommended, by folder name. */
export const RECOMMENDED_SKILL_IDS = [
  "action-items-to-linear",
  "meeting-summary-to-slack",
  "one-on-one-prep",
  "meeting-decisions",
] as const;

const WRITE_ERROR_REASONS: Partial<Record<SkillWriteError | "exists", string>> = {
  noSpace: "skills.toasts.writeFailedNoSpace",
  permission: "skills.toasts.writeFailedPermission",
  exists: "skills.upload.duplicate",
};

/** The toast for a save that failed, with its reason when there is one. */
export function writeFailedToast(t: TFunction, error?: string): ToastProps {
  const reason = error ? WRITE_ERROR_REASONS[error as keyof typeof WRITE_ERROR_REASONS] : undefined;
  return {
    title: t("skills.toasts.writeFailed"),
    ...(reason ? { description: t(reason) } : {}),
    variant: "destructive" as const,
  };
}

export function problemKey(issue: SkillIssue<SkillProblemCode>): string {
  return `skills.problems.${issue.code}`;
}

export function warningKey(issue: SkillIssue<SkillWarningCode>): string {
  return `skills.warnings.${issue.code}`;
}

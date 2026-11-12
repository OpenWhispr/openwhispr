import { useTranslation } from "react-i18next";

/** Why a typed `$VAR` reference wasn't saved, shown beside its field. */
export default function SecretRefErrorText({ code }: { code?: string | null }) {
  const { t } = useTranslation();
  if (!code) return null;
  const message =
    code === "self-reference"
      ? t("apiKeyInput.selfReference")
      : code === "unknown-ref"
        ? t("apiKeyInput.unknownRef")
        : code;
  return (
    <p role="alert" className="text-xs text-destructive mt-1">
      {message}
    </p>
  );
}

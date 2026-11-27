import { useTranslation } from "react-i18next";
import { describeSecretRefError } from "../../utils/describeProviderError";

/** Why a typed `$VAR` reference wasn't saved, shown beside its field. */
export default function SecretRefErrorText({ code }: { code?: string | null }) {
  const { t } = useTranslation();
  const message = describeSecretRefError(code, t);
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-destructive mt-1">
      {message}
    </p>
  );
}

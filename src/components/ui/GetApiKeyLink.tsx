import { useTranslation } from "react-i18next";
import { createExternalLinkHandler, withUtm } from "../../utils/externalLinks";

export function GetApiKeyLink({ url }: { url: string }) {
  const { t } = useTranslation();
  const href = withUtm(url, "api_key");
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={createExternalLinkHandler(href)}
      className="text-xs text-link underline decoration-link/30 hover:decoration-link/60 cursor-pointer transition-colors"
    >
      {t("reasoning.getApiKey")}
    </a>
  );
}

import { useTranslation } from "react-i18next";
import type { GpuOffers } from "../utils/gpuBannerPolicy";

export default function GpuBannerMessage({ offers }: { offers: GpuOffers }) {
  const { t } = useTranslation();
  const titleKey = offers.transcription
    ? offers.intelligence
      ? "controlPanel.gpu.bannerTitle"
      : "controlPanel.gpu.transcriptionTitle"
    : "controlPanel.gpu.intelligenceTitle";
  const descriptionKey = offers.transcription
    ? offers.intelligence
      ? "controlPanel.gpu.bannerDescription"
      : "controlPanel.gpu.transcriptionDescription"
    : "controlPanel.gpu.intelligenceDescription";
  return (
    <>
      <p className="text-xs font-medium text-foreground mb-0.5">{t(titleKey)}</p>
      <p className="text-xs text-muted-foreground mb-2">{t(descriptionKey)}</p>
    </>
  );
}

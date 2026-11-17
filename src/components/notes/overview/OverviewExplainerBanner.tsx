import { useState } from "react";
import { X } from "../../icons";
import { useTranslation } from "react-i18next";
import {
  CONTAINER_OVERVIEW_INTRO,
  markIntroSeen,
  shouldShowIntro,
} from "../../../lib/versionedIntro";

interface OverviewExplainerBannerProps {
  kind: "team" | "private";
}

export function OverviewExplainerBanner({ kind }: OverviewExplainerBannerProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(() =>
    shouldShowIntro(localStorage, CONTAINER_OVERVIEW_INTRO)
  );

  if (!visible) return null;

  return (
    <div className="relative rounded-lg bg-brand-solid/5 dark:bg-brand-solid/8 border border-brand-solid/10 dark:border-brand-solid/15 px-4 py-3">
      <button
        onClick={() => {
          markIntroSeen(localStorage, CONTAINER_OVERVIEW_INTRO);
          setVisible(false);
        }}
        aria-label={t("notes.overview.banner.dismiss")}
        className="absolute top-2.5 end-2.5 h-5 w-5 flex items-center justify-center rounded-sm text-primary/45 hover:text-primary/60 hover:bg-text-primary/6 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-focus/30"
      >
        <X size={12} />
      </button>
      <p className="text-xs font-medium text-primary/80 mb-0.5">
        {t(`notes.overview.banner.title.${kind}`)}
      </p>
      <p className="text-xs text-primary/55 dark:text-primary/45 max-w-lg pe-6">
        {t(`notes.overview.banner.body.${kind}`)}
      </p>
    </div>
  );
}

import { useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  markContainerOverviewIntroSeen,
  shouldShowContainerOverviewIntro,
} from "../../../lib/containerOverviewIntro";

interface OverviewExplainerBannerProps {
  kind: "team" | "private";
}

export function OverviewExplainerBanner({ kind }: OverviewExplainerBannerProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(() => shouldShowContainerOverviewIntro(localStorage));

  if (!visible) return null;

  return (
    <div className="relative rounded-lg bg-primary/5 dark:bg-primary/8 border border-primary/10 dark:border-primary/15 px-4 py-3">
      <button
        onClick={() => {
          markContainerOverviewIntroSeen(localStorage);
          setVisible(false);
        }}
        aria-label={t("notes.overview.banner.dismiss")}
        className="absolute top-2.5 right-2.5 h-5 w-5 flex items-center justify-center rounded-sm text-foreground/30 hover:text-foreground/60 hover:bg-foreground/6 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
      >
        <X size={12} />
      </button>
      <p className="text-xs font-medium text-foreground/80 mb-0.5">
        {t(`notes.overview.banner.title.${kind}`)}
      </p>
      <p className="text-xs text-foreground/55 dark:text-foreground/45 max-w-lg pr-6">
        {t(`notes.overview.banner.body.${kind}`)}
      </p>
    </div>
  );
}

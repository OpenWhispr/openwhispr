import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

interface ToneStyleBannerProps {
  cleanupEnabled: boolean;
  onStart: () => void;
  onDismiss: () => void;
}

// A soft brand glow with a dictated line curving through it, as in the design.
function BannerDecoration() {
  const { t } = useTranslation();
  const id = useId();
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 end-0 h-full w-[400px] [mask-image:linear-gradient(to_right,transparent,black_40%)] rtl:[mask-image:linear-gradient(to_left,transparent,black_40%)]"
      viewBox="0 0 400 100"
      preserveAspectRatio="xMaxYMax slice"
    >
      <defs>
        <radialGradient
          id={`${id}-glow`}
          gradientUnits="userSpaceOnUse"
          cx="300"
          cy="130"
          r="230"
          gradientTransform="translate(0 52) scale(1 0.6)"
        >
          <stop offset="0" stopColor="var(--color-primary)" stopOpacity="0.32" />
          <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0" />
        </radialGradient>
        <path id={`${id}-curve`} d="M0 74 C 70 54, 150 62, 230 92 S 350 118, 410 80" />
      </defs>
      <rect width="400" height="100" fill={`url(#${id}-glow)`} />
      <text className="fill-primary/25 text-[13px]">
        <textPath href={`#${id}-curve`}>{t("toneStyle.banner.decoration")}</textPath>
      </text>
    </svg>
  );
}

export default function ToneStyleBanner({
  cleanupEnabled,
  onStart,
  onDismiss,
}: ToneStyleBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="relative mb-3 flex items-center gap-4 overflow-hidden rounded-2xl border border-border/70 bg-card px-6 py-5 dark:border-white/10 dark:bg-surface-2">
      <BannerDecoration />
      <div className="relative min-w-0 flex-1">
        <p className="brand-heading text-[17px] font-medium text-foreground">
          {cleanupEnabled ? t("toneStyle.banner.title") : t("toneStyle.banner.cleanupOffTitle")}
        </p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {cleanupEnabled
            ? t("toneStyle.banner.description")
            : t("toneStyle.banner.cleanupOffDescription")}
        </p>
      </div>
      <div className="relative flex shrink-0 items-center gap-3">
        <Button className="h-[42px] px-6 text-[15px]" onClick={onStart}>
          {cleanupEnabled ? t("toneStyle.banner.start") : t("toneStyle.turnOnAndSetUp")}
        </Button>
        <Button
          variant="secondary"
          className="h-[42px] border-transparent px-6 text-[15px] text-muted-foreground"
          onClick={onDismiss}
        >
          {t("toneStyle.banner.notNow")}
        </Button>
      </div>
    </div>
  );
}

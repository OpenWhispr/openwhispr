import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

interface ToneStyleBannerProps {
  cleanupEnabled: boolean;
  onStart: () => void;
  onDismiss: () => void;
}

// The curved line reaches the description's height about 410px before the
// banner's end, so the description has to end this far from it for the line to show.
const LINE_CLEARANCE_PX = 425;

// The design's decoration: two soft brand glows rising from the bottom edge and
// a line of text curving between them, drawn from the banner's end. In RTL the
// glows mirror; the line keeps reading left to right.
function BannerDecoration({ showLine }: { showLine: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 end-0 h-full w-[700px] [mask-image:linear-gradient(to_right,transparent,black_25%)] rtl:[mask-image:linear-gradient(to_left,transparent,black_25%)]"
      viewBox="0 0 700 100"
      preserveAspectRatio="xMaxYMax meet"
    >
      <defs>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" stopColor="var(--color-primary)" stopOpacity="0.4" />
          <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0" />
        </radialGradient>
        <path
          id={`${id}-curve`}
          d="M228 190 C255 110 300 42 345 42 C420 42 500 100 570 106 S680 95 720 62"
        />
      </defs>
      <g className="origin-center [transform-box:view-box] rtl:-scale-x-100">
        <ellipse cx="225" cy="108" rx="230" ry="95" fill={`url(#${id}-glow)`} />
        <ellipse cx="690" cy="110" rx="240" ry="100" fill={`url(#${id}-glow)`} />
        <ellipse cx="450" cy="112" rx="170" ry="55" fill={`url(#${id}-glow)`} opacity="0.45" />
      </g>
      {showLine && (
        <text className="fill-primary/22 text-[11px] [direction:ltr]">
          <textPath href={`#${id}-curve`} startOffset="47">
            {t("toneStyle.banner.decoration")}
          </textPath>
        </text>
      )}
    </svg>
  );
}

export default function ToneStyleBanner({
  cleanupEnabled,
  onStart,
  onDismiss,
}: ToneStyleBannerProps) {
  const { t } = useTranslation();
  const bannerRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [showLine, setShowLine] = useState(false);

  // The description keeps to one line, so the line is dropped rather than the
  // description wrapped when the two would meet.
  useEffect(() => {
    const banner = bannerRef.current;
    const description = descriptionRef.current;
    if (!banner || !description) return;
    const measure = () => {
      const outer = banner.getBoundingClientRect();
      const text = description.getBoundingClientRect();
      const room =
        getComputedStyle(banner).direction === "rtl"
          ? text.left - outer.left
          : outer.right - text.right;
      setShowLine(room >= LINE_CLEARANCE_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(banner);
    observer.observe(description);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={bannerRef}
      className="relative mb-3 flex items-center gap-4 overflow-hidden rounded-2xl border border-border/70 bg-card px-5 py-5 dark:border-white/10 dark:bg-surface-2"
    >
      <BannerDecoration showLine={showLine} />
      <div className="relative min-w-0 flex-1">
        <p className="brand-heading text-[19px] font-medium! tracking-normal! text-foreground">
          {cleanupEnabled ? t("toneStyle.banner.title") : t("toneStyle.banner.cleanupOffTitle")}
        </p>
        <p
          ref={descriptionRef}
          className="mt-1.5 w-fit max-w-full text-[15px] text-muted-foreground/90"
        >
          {cleanupEnabled
            ? t("toneStyle.banner.description")
            : t("toneStyle.banner.cleanupOffDescription")}
        </p>
      </div>
      <div className="relative flex shrink-0 items-center gap-3">
        <Button className="h-10 px-6 text-sm" onClick={onStart}>
          {cleanupEnabled ? t("toneStyle.banner.start") : t("toneStyle.turnOnAndSetUp")}
        </Button>
        <Button
          variant="secondary"
          className="h-10 border-transparent bg-[color-mix(in_srgb,var(--color-foreground)_10%,var(--color-card))] px-6 text-sm text-muted-foreground/70 hover:bg-[color-mix(in_srgb,var(--color-foreground)_14%,var(--color-card))]"
          onClick={onDismiss}
        >
          {t("toneStyle.banner.notNow")}
        </Button>
      </div>
    </div>
  );
}

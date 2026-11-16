import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import type { DictationTone, ToneAppCategory } from "../../config/toneStyle";

/** Overlapping round app badges; `size` is each badge's width in pixels. */
export function AppMarkStack({ marks, size }: { marks: string[]; size: number }) {
  return (
    <div className="flex shrink-0" aria-hidden="true">
      {marks.map((src, index) => (
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          decoding="async"
          draggable={false}
          className="select-none rounded-full ring-2 ring-card dark:ring-surface-2"
          style={{ marginInlineStart: index === 0 ? 0 : -size * 0.24 }}
        />
      ))}
    </div>
  );
}

function Bubble({ text, selected }: { text: string; selected: boolean }) {
  return (
    <div
      className={cn(
        "relative max-w-[92%] rounded-2xl px-2.5 py-2 text-[15px] leading-[21px] text-white",
        selected ? "bg-primary" : "bg-[#2f8cf7]"
      )}
    >
      {text}
      {/* The tail flares out of the bubble's side just above its rounded corner. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 13 9"
        className={cn(
          "absolute -end-[9px] bottom-[5px] h-[9px] w-[13px] rtl:-scale-x-100",
          selected ? "fill-primary" : "fill-[#2f8cf7]"
        )}
      >
        <path d="M0 0H4C4 4 7 7 13 8C9 8.6 4 8.4 0 7.8Z" />
      </svg>
    </div>
  );
}

function WorkMessage({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[#b3613a] text-[13px] font-semibold text-white">
        {t("toneStyle.samples.work.sender").slice(0, 1)}
      </div>
      <div className="min-w-0">
        <p className="text-[13px] leading-[18px]">
          <span className="font-semibold text-foreground">
            {t("toneStyle.samples.work.sender")}
          </span>{" "}
          <span className="text-muted-foreground">{t("toneStyle.samples.work.time")}</span>
        </p>
        <p className="mt-0.5 text-[15px] leading-[21px] text-foreground">{text}</p>
      </div>
    </div>
  );
}

function EmailMessage({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="text-[13px] leading-[18px]">
      <p className="border-b border-border/80 pb-2.5 text-muted-foreground dark:border-white/10">
        {t("toneStyle.samples.email.to")}
      </p>
      <p className="mt-2 whitespace-pre-line text-foreground">{text}</p>
    </div>
  );
}

/** How a message reads in one tone, drawn like the app it would be sent from. */
export function ToneSample({
  category,
  tone,
  selected,
}: {
  category: ToneAppCategory;
  tone: DictationTone;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const text = t(`toneStyle.samples.${category}.${tone}`);
  if (category === "personal") return <Bubble text={text} selected={selected} />;
  if (category === "work") return <WorkMessage text={text} />;
  if (category === "email") return <EmailMessage text={text} />;
  return <p className="text-[15px] leading-[21px] text-foreground">{text}</p>;
}

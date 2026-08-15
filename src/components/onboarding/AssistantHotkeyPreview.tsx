import { Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import grassBackdrop from "../../assets/onboarding-assistant-grass.webp";

function AssistantWaveform() {
  return (
    <div className="flex h-8 items-center gap-1 rounded-full bg-neutral-950/80 px-3 text-violet-300 shadow-sm backdrop-blur-sm">
      <Sparkles className="size-3.5" />
      <span className="flex items-center gap-0.5" aria-hidden="true">
        {[3, 7, 10, 5, 12, 8, 14, 6, 10, 4].map((height, index) => (
          <span
            key={`${height}-${index}`}
            className="w-px rounded-full bg-white"
            style={{ height }}
          />
        ))}
      </span>
    </div>
  );
}

export default function AssistantHotkeyPreview() {
  const { t } = useTranslation();

  return (
    <div
      className="relative mx-auto mt-8 aspect-video w-full max-w-[28rem] overflow-hidden rounded-2xl bg-cover bg-center shadow-sm"
      style={{ backgroundImage: `url(${grassBackdrop})` }}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-950/5 via-transparent to-amber-300/15" />

      <section className="absolute bottom-0 left-8 h-40 w-52 overflow-hidden rounded-t-xl bg-white text-left text-neutral-950 shadow-lg">
        <div className="flex h-8 items-center justify-between border-b border-neutral-200 px-3 text-[10px] font-medium">
          <span>{t("onboarding.rehaul.assistantHotkey.preview.newMessage")}</span>
          <X className="size-3" />
        </div>
        <div className="mx-2 flex h-7 items-center gap-1 border-b border-neutral-200 text-[10px]">
          <span className="text-neutral-400">
            {t("onboarding.rehaul.assistantHotkey.preview.toLabel")}
          </span>
          <span className="font-medium">
            {t("onboarding.rehaul.assistantHotkey.preview.recipient")}
          </span>
        </div>
        <div className="mx-2 flex h-7 items-center gap-1 border-b border-neutral-200 text-[10px]">
          <span className="text-neutral-400">
            {t("onboarding.rehaul.assistantHotkey.preview.subjectLabel")}
          </span>
          <span className="font-medium">
            {t("onboarding.rehaul.assistantHotkey.preview.subject")}
          </span>
        </div>
        <div className="space-y-1 px-2 pt-2 text-[10px] leading-3.5">
          <p>{t("onboarding.rehaul.assistantHotkey.preview.greeting")}</p>
          <p className="font-medium">
            {t("onboarding.rehaul.assistantHotkey.preview.bodyLineOne")}
          </p>
          <p className="text-neutral-400">
            {t("onboarding.rehaul.assistantHotkey.preview.bodyLineTwo")}
          </p>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-white to-transparent" />
      </section>

      <div className="absolute right-0 top-9 w-[19.5rem] rounded-l-2xl bg-neutral-950/45 px-4 py-4 text-left text-sm italic leading-5 text-white shadow-sm backdrop-blur-sm">
        “{t("onboarding.rehaul.assistantHotkey.preview.prompt")}”
      </div>

      <div className="absolute right-1 top-[42%]">
        <AssistantWaveform />
      </div>
    </div>
  );
}

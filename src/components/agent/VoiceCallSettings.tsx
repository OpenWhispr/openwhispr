import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Minus, Plus, Search, X } from "../icons";
import { cn } from "../lib/utils";
import { ICON_BUTTON } from "../chat/interactions/cardStyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useSettingsStore } from "../../stores/settingsStore";
import { getLanguageLabel } from "../../utils/languageSupport";
import {
  VOICE_CALL_LANGUAGES,
  VOICE_CALL_SPEED,
  VOICE_CALL_VOICES,
} from "../../utils/voiceCallSettings";
import type { VoiceCallLanguage } from "../../services/voice/types";

// A control at the right of a row: the voice and language menus' triggers.
const MENU_TRIGGER =
  "flex h-8 min-w-[118px] items-center justify-between gap-2 rounded-full border border-border bg-surface-1 ps-3 pe-2 text-[14px] text-foreground transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 data-[state=open]:bg-surface-2";
const MENU_ITEM =
  "flex items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[14px] text-foreground";

// Room above the panel while a menu is open: the window is only as tall as
// what it shows, and the menus rise above the panel (the language list most).
const MENU_ROOM_PX = { voice: 48, language: 124 } as const;

const VOICE_LABELS = {
  helios: {
    name: "agentWindow.call.settings.voices.helios",
    kind: "agentWindow.call.settings.male",
  },
  aurora: {
    name: "agentWindow.call.settings.voices.aurora",
    kind: "agentWindow.call.settings.female",
  },
} as const;

function useLanguageName() {
  const { t, i18n } = useTranslation();
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([i18n.language], { type: "language" });
    } catch {
      names = null;
    }
    return (language: VoiceCallLanguage) =>
      language === "auto"
        ? t("agentWindow.call.settings.autoDetect")
        : (names?.of(language) ?? getLanguageLabel(language));
  }, [i18n.language, t]);
}

/**
 * Which call languages a downloaded speech model can hear now; null until
 * main answers. Re-read each time the settings open, since a model may have
 * been downloaded meanwhile.
 */
function useHeardLanguages(): Set<VoiceCallLanguage> | null {
  const [heard, setHeard] = useState<Set<VoiceCallLanguage> | null>(null);
  const parakeetModel = useSettingsStore((state) =>
    state.localTranscriptionProvider === "cohere" ? state.cohereModel : state.parakeetModel
  );
  const whisperModel = useSettingsStore((state) => state.whisperModel);
  useEffect(() => {
    let current = true;
    void window.electronAPI?.voiceConversation
      ?.languages({
        preferredParakeet: parakeetModel || undefined,
        preferredWhisper: whisperModel || undefined,
      })
      .then((languages) => {
        if (current) {
          setHeard(
            new Set(languages.filter(({ engine }) => engine).map(({ language }) => language))
          );
        }
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [parakeetModel, whisperModel]);
  return heard;
}

function LanguagePicker({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const language = useSettingsStore((state) => state.voiceCallLanguage);
  const setLanguage = useSettingsStore((state) => state.setVoiceCallLanguage);
  const nameOf = useLanguageName();
  const heard = useHeardLanguages();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = VOICE_CALL_LANGUAGES.filter((code) =>
    nameOf(code).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger className={MENU_TRIGGER} aria-label={t("agentWindow.call.settings.language")}>
        <span className="truncate">{nameOf(language)}</span>
        <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        collisionPadding={8}
        className="w-[220px] min-w-0 rounded-xl p-1.5"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <label className="mb-1 flex items-center gap-2 rounded-lg bg-surface-1 px-2.5 py-1.5 text-muted-foreground">
          <Search size={14} className="shrink-0" />
          <input
            dir="auto"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("agentWindow.call.settings.searchLanguages")}
            aria-label={t("agentWindow.call.settings.searchLanguages")}
            className="input-inline min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        </label>
        <div role="listbox" aria-label={t("agentWindow.call.settings.language")}>
          {matches.length === 0 && (
            <p className="px-2.5 py-2 text-[14px] text-muted-foreground">
              {t("agentWindow.call.settings.noLanguages")}
            </p>
          )}
          {matches.map((code) => {
            // Unknown until main answers: offered; one no model hears is set back mid-call,
            // and checked again when a call starts.
            const available = heard === null || heard.has(code);
            return (
              <button
                key={code}
                type="button"
                role="option"
                aria-selected={code === language}
                disabled={!available}
                title={
                  available
                    ? undefined
                    : t("agentWindow.call.settings.languageUnavailable", { language: nameOf(code) })
                }
                onClick={() => {
                  setLanguage(code);
                  setOpen(false);
                  onOpenChange(false);
                }}
                className={cn(
                  MENU_ITEM,
                  "w-full text-start transition-colors hover:bg-foreground/5 focus:outline-none focus-visible:bg-foreground/5 disabled:cursor-default disabled:hover:bg-transparent"
                )}
              >
                <span className={cn("flex flex-col", !available && "text-muted-foreground")}>
                  {nameOf(code)}
                  {!available && (
                    <span className="text-[12px]">
                      {t("agentWindow.call.settings.needsSpeechModel")}
                    </span>
                  )}
                </span>
                {code === language && <Check size={14} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The call's settings, above its pill or over its transcript: the voice and
 * rate replies are spoken with, and the language the call hears and answers
 * in. Each change applies from the next reply; the call and its chat go on.
 */
export function VoiceCallSettings({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const voice = useSettingsStore((state) => state.voiceCallVoice);
  const setVoice = useSettingsStore((state) => state.setVoiceCallVoice);
  const speed = useSettingsStore((state) => state.voiceCallSpeed);
  const setSpeed = useSettingsStore((state) => state.setVoiceCallSpeed);
  const speedLabel = t("agentWindow.call.settings.speedValue", {
    value: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(speed),
  });
  const [openMenu, setOpenMenu] = useState<keyof typeof MENU_ROOM_PX | null>(null);
  const menuOpenChange = (menu: keyof typeof MENU_ROOM_PX) => (open: boolean) =>
    setOpenMenu((current) => (open ? menu : current === menu ? null : current));

  return (
    <div className="flex flex-col items-center">
      {openMenu && <div aria-hidden="true" style={{ height: MENU_ROOM_PX[openMenu] }} />}
      <div
        role="dialog"
        aria-label={t("agentWindow.call.settings.title")}
        className="agent-panel flex w-[320px] max-w-full flex-col gap-1 rounded-[20px] border border-border bg-surface-0 px-4 pt-3 pb-4 text-foreground shadow-[var(--shadow-card)]"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-center justify-between pb-1">
          <h2 className="text-[16px] font-medium">{t("agentWindow.call.settings.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("agentWindow.call.settings.close")}
            title={t("agentWindow.call.settings.close")}
            className={ICON_BUTTON}
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex h-11 items-center justify-between">
          <span className="text-[15px]">{t("agentWindow.call.settings.voice")}</span>
          <DropdownMenu onOpenChange={menuOpenChange("voice")}>
            <DropdownMenuTrigger
              className={MENU_TRIGGER}
              aria-label={t("agentWindow.call.settings.voice")}
            >
              <span className="truncate">{t(VOICE_LABELS[voice].name)}</span>
              <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" collisionPadding={8} className="w-[184px]">
              {VOICE_CALL_VOICES.map((option) => (
                <DropdownMenuItem
                  key={option}
                  onSelect={() => setVoice(option)}
                  className={MENU_ITEM}
                >
                  <span>
                    {t(VOICE_LABELS[option].name)} · {t(VOICE_LABELS[option].kind)}
                  </span>
                  {option === voice && <Check size={14} className="shrink-0" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex h-11 items-center justify-between">
          <span className="text-[15px]">{t("agentWindow.call.settings.speed")}</span>
          <div className="flex h-8 min-w-[118px] items-center justify-between rounded-full border border-border bg-surface-1 px-1">
            <button
              type="button"
              onClick={() => setSpeed(speed - VOICE_CALL_SPEED.step)}
              disabled={speed <= VOICE_CALL_SPEED.min}
              aria-label={t("agentWindow.call.settings.slower")}
              title={t("agentWindow.call.settings.slower")}
              className={cn(ICON_BUTTON, "size-6 active:bg-foreground/15")}
            >
              <Minus size={14} />
            </button>
            <span className="min-w-10 text-center text-[14px] tabular-nums" aria-live="polite">
              {speedLabel}
            </span>
            <button
              type="button"
              onClick={() => setSpeed(speed + VOICE_CALL_SPEED.step)}
              disabled={speed >= VOICE_CALL_SPEED.max}
              aria-label={t("agentWindow.call.settings.faster")}
              title={t("agentWindow.call.settings.faster")}
              className={cn(ICON_BUTTON, "size-6 active:bg-foreground/15")}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="flex h-11 items-center justify-between">
          <span className="text-[15px]">{t("agentWindow.call.settings.language")}</span>
          <LanguagePicker onOpenChange={menuOpenChange("language")} />
        </div>
      </div>
    </div>
  );
}

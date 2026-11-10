import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
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
  "flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[14px] leading-5 text-foreground";
// The gap between a menu and its trigger.
const MENU_OFFSET = 6;
// The speed stepper's − and +: bright until they reach a bound.
const STEPPER_BUTTON = cn(
  ICON_BUTTON,
  "size-6 text-foreground active:bg-foreground/15 disabled:text-muted-foreground"
);

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

/** Names a call language in the app's language, or in `locale` when given. */
export function useLanguageName(locale?: string) {
  const { t, i18n } = useTranslation();
  const lng = locale ?? i18n.language;
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([lng], { type: "language" });
    } catch {
      names = null;
    }
    return (language: VoiceCallLanguage) =>
      language === "auto"
        ? t("agentWindow.call.settings.autoDetect", { lng })
        : (names?.of(language) ?? getLanguageLabel(language));
  }, [lng, t]);
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

function LanguagePicker({ menuRef }: { menuRef: Ref<HTMLDivElement> }) {
  const { t } = useTranslation();
  const language = useSettingsStore((state) => state.voiceCallLanguage);
  const setLanguage = useSettingsStore((state) => state.setVoiceCallLanguage);
  const nameOf = useLanguageName();
  const englishName = useLanguageName("en");
  const heard = useHeardLanguages();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // A language is found by its name in the app's language or in English.
  const needle = query.trim().toLocaleLowerCase();
  const matches = VOICE_CALL_LANGUAGES.filter((code) =>
    [nameOf(code), englishName(code)].some((name) => name.toLocaleLowerCase().includes(needle))
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger className={MENU_TRIGGER} aria-label={t("agentWindow.call.settings.language")}>
        <span className="truncate">{nameOf(language)}</span>
        <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        ref={menuRef}
        align="end"
        side="top"
        sideOffset={MENU_OFFSET}
        collisionPadding={8}
        className="w-[220px] min-w-0 rounded-xl p-1.5"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <label className="mb-1 flex h-8 items-center gap-2 rounded-lg bg-foreground/4 px-2.5 text-muted-foreground">
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
        <div
          role="listbox"
          aria-label={t("agentWindow.call.settings.language")}
          className="flex flex-col gap-1"
        >
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
                }}
                className={cn(
                  MENU_ITEM,
                  "w-full text-start transition-colors hover:bg-foreground/5 focus:outline-none focus-visible:bg-foreground/5 disabled:cursor-default disabled:hover:bg-transparent",
                  code === language && "bg-foreground/8 hover:bg-foreground/8"
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
  // An open menu rises above the panel, and the window is only as tall as what
  // it shows: it makes room above the panel for the part of the menu that rises
  // past it, as measured (a language that needs a model takes two lines). A
  // menu still fading out leaves the room of the one opened after it.
  const panelRef = useRef<HTMLDivElement>(null);
  const [menuRoom, setMenuRoom] = useState<{ menu: HTMLElement; height: number } | null>(null);
  const fitMenu = useCallback((menu: HTMLDivElement | null) => {
    const panel = panelRef.current;
    const trigger = panel?.querySelector<HTMLElement>("[aria-expanded=true]");
    if (!menu || !panel || !trigger) return undefined;
    const observer = new ResizeObserver(() => {
      const triggerTop = trigger.getBoundingClientRect().top - panel.getBoundingClientRect().top;
      const height = Math.max(0, Math.ceil(menu.offsetHeight + MENU_OFFSET - triggerTop));
      setMenuRoom({ menu, height });
    });
    observer.observe(menu);
    return () => {
      observer.disconnect();
      setMenuRoom((room) => (room?.menu === menu ? null : room));
    };
  }, []);

  return (
    <div className="flex flex-col items-center">
      {menuRoom && <div aria-hidden="true" style={{ height: menuRoom.height }} />}
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t("agentWindow.call.settings.title")}
        className="agent-panel flex w-[320px] max-w-full flex-col rounded-[20px] border border-border bg-surface-0 px-3 pt-1.5 pb-2 text-foreground shadow-[var(--shadow-card)]"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-center justify-between pb-1.5">
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
          <DropdownMenu>
            <DropdownMenuTrigger
              className={MENU_TRIGGER}
              aria-label={t("agentWindow.call.settings.voice")}
            >
              <span className="truncate">{t(VOICE_LABELS[voice].name)}</span>
              <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              ref={fitMenu}
              align="end"
              side="top"
              sideOffset={MENU_OFFSET}
              collisionPadding={8}
              className="flex w-[184px] flex-col gap-1"
            >
              {VOICE_CALL_VOICES.map((option) => (
                <DropdownMenuItem
                  key={option}
                  role="menuitemradio"
                  aria-checked={option === voice}
                  onSelect={() => setVoice(option)}
                  className={cn(
                    MENU_ITEM,
                    option === voice && "bg-foreground/8 focus:bg-foreground/8"
                  )}
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
              className={STEPPER_BUTTON}
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
              className={STEPPER_BUTTON}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="flex h-11 items-center justify-between">
          <span className="text-[15px]">{t("agentWindow.call.settings.language")}</span>
          <LanguagePicker menuRef={fitMenu} />
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import {
  AlertCircle,
  BanknoteCheck,
  ChevronRight,
  GalleryVerticalEnd,
  KeyRound,
  Laptop,
  MonitorSmartphone,
  Server,
  ShieldCheck,
  WandSparkles,
  WifiOff,
  Zap,
} from "../icons";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { getTranscriptionProviders, modelRegistry } from "../../models/ModelRegistry";
import type { OnboardingSetupMode } from "./flow";
import { getOnboardingSetupAvailability, hasAvailableOnboardingSetup } from "./setupEligibility";
import { BrandMark } from "./OnboardingShell";
import { LOCAL_ASR_ORGANIZATIONS } from "../../helpers/localASROrganization";
import { getProviderIcon, isMonochromeProvider } from "@/utils/providerIcons";
import { cn } from "../lib/utils";
import apiSetupHero from "../../assets/onboarding-api-setup-hero.webp";

type SetupMode = Exclude<OnboardingSetupMode, null>;

// What the Local card quotes until OnboardingFlow has worked out the local setup.
const DEFAULT_LOCAL_SPACE_GB = 2;

interface SetupChoiceStepProps {
  isSignedIn: boolean;
  agentAllowed: boolean;
  /**
   * Free space the local setup needs, in whole GB: every recommended row on,
   * with the room each download reserves to unpack.
   */
  localSpaceGb?: number;
  onSelect: (mode: SetupMode, options?: { selfHosted?: boolean }) => void;
  onRequestAuthentication: () => void;
}

interface MoreSetupOption {
  id: "byok" | "self-hosted";
  icon: typeof KeyRound;
  title: string;
  description: string;
}

// Figma "Frame 49"–"Frame 52": row, gap 8, a 14px mark beside 14/140% body.
// The mark is tertiary grey on the self-serve cards and the brand accent on the
// cloud card, which is the only visual weighting between them.
//
// strokeWidth stays at the icon set's default 2 rather than the 1.16667 the
// export shows. Both describe the same line: Figma exports these at viewBox
// 0 0 14 14, so its 1.16667 is already in 14px space, while the icons draw in a
// 24 viewBox scaled down to 14 — 2 x (14/24) = 1.1667 device px, exactly the
// spec. Passing 1.167 here applies the scale twice and renders a 0.68px hairline.
function Feature({
  icon: Icon,
  accent = false,
  children,
}: {
  icon: typeof Zap;
  accent?: boolean;
  children: string;
}) {
  return (
    <li className="flex items-center gap-1.5 text-xs leading-[1.4] text-[var(--onboarding-text-primary)]">
      <Icon
        className={`size-3 shrink-0 ${accent ? "text-[var(--onboarding-accent)]" : "text-[var(--onboarding-text-tertiary)]"}`}
      />
      {children}
    </li>
  );
}

// Compact setup card: content stays pinned to the top and the action to the bottom.
function SetupCard({ children }: { children: React.ReactNode }) {
  return (
    <section className="relative flex h-[350px] w-68 shrink-0 flex-col justify-between overflow-hidden rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 pb-5 pt-4 text-start">
      {children}
    </section>
  );
}

// Figma "Frame 25": pad 8 20, radius 38, 14/140% medium. Brand fill or stroke.
function CardAction({
  brand = false,
  onClick,
  children,
}: {
  brand?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`onboarding-pressable relative z-10 w-full rounded-[38px] px-4 py-1.5 text-xs font-medium leading-[1.4] ${
        brand
          ? "bg-[var(--onboarding-accent)] text-[var(--onboarding-accent-foreground)] hover:brightness-95"
          : "border border-[var(--onboarding-control-border)] text-[var(--onboarding-text-primary)] hover:bg-[var(--onboarding-surface-hover)]"
      }`}
    >
      {children}
    </button>
  );
}

export default function SetupChoiceStep({
  isSignedIn,
  agentAllowed,
  localSpaceGb = DEFAULT_LOCAL_SPACE_GB,
  onSelect,
  onRequestAuthentication,
}: SetupChoiceStepProps) {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const [showMore, setShowMore] = useState(false);

  const availability = getOnboardingSetupAvailability({
    policy,
    agentAllowed,
    transcriptionProviders: getTranscriptionProviders(),
    llmProviders: modelRegistry.getCloudProviders(),
  });
  const {
    cloud: cloudAllowed,
    local: localAllowed,
    byok: byokAllowed,
    selfHosted: selfHostedAllowed,
  } = availability;
  const moreOptionsAllowed = byokAllowed || selfHostedAllowed;

  const chooseCloud = () => {
    if (isSignedIn) onSelect("cloud");
    else onRequestAuthentication();
  };

  const moreSetupOptions: MoreSetupOption[] = [];
  if (byokAllowed) {
    moreSetupOptions.push({
      id: "byok",
      icon: KeyRound,
      title: t("onboarding.rehaul.setupChoice.byok.title"),
      description: t("onboarding.rehaul.setupChoice.byok.description"),
    });
  }
  if (selfHostedAllowed) {
    moreSetupOptions.push({
      id: "self-hosted",
      icon: Server,
      title: t("onboarding.rehaul.setupChoice.moreOptions.selfHosted.title"),
      description: t("onboarding.rehaul.setupChoice.moreOptions.selfHosted.description"),
    });
  }

  if (!hasAvailableOnboardingSetup(availability)) {
    return (
      <div
        role="alert"
        className="mx-auto mt-8 flex w-full max-w-md flex-col items-center rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-6 py-8 text-center"
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-[var(--onboarding-surface-secondary)] text-[var(--onboarding-accent)]">
          <AlertCircle className="size-5" />
        </span>
        <h2 className="mt-4 text-base font-semibold text-[var(--onboarding-text-primary)]">
          {t("onboarding.rehaul.setupChoice.unavailable.title")}
        </h2>
        <p className="mt-2 text-sm leading-5 text-[var(--onboarding-text-secondary)]">
          {t("onboarding.rehaul.setupChoice.unavailable.description")}
        </p>
      </div>
    );
  }

  return (
    // Figma "Frame 2147259042": column, gap 32, centred — the card row above the
    // Show More Options pill.
    <div className="mx-auto mt-5 flex w-full flex-col items-center gap-4">
      {/* Frame 60: row, gap 16. */}
      <div className="onboarding-stagger flex items-start justify-center gap-3">
        {localAllowed && (
          <SetupCard>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                {/* Frame 2147259034: the local model marks overlap by 8, each on a
                    1.33px surface ring so the stack reads front-to-back. NVIDIA's
                    tile is its own green field, so it fills the chip and is clipped
                    to the circle; the other marks sit inside it, with OpenAI's
                    inverted onto the dark chip. */}
                <span className="flex -space-x-2">
                  {LOCAL_ASR_ORGANIZATIONS.map(({ id }) => (
                    <span
                      key={id}
                      className="flex size-9 items-center justify-center overflow-hidden rounded-full bg-[var(--onboarding-inverse-surface)] ring-[1.33px] ring-[var(--onboarding-surface)]"
                    >
                      <img
                        src={getProviderIcon(id)}
                        alt=""
                        aria-hidden="true"
                        decoding="async"
                        draggable={false}
                        className={cn(
                          id === "nvidia" ? "size-full object-cover" : "size-4",
                          isMonochromeProvider(id) && "invert dark:invert-0"
                        )}
                      />
                    </span>
                  ))}
                </span>
                {/* Frame 49: pad 4 9, radius 47, surface-tertiary, 10/140%. */}
                <span className="rounded-[47px] bg-[var(--onboarding-surface-tertiary)] px-[9px] py-1 text-[10px] leading-[1.4] text-[var(--onboarding-text-primary)]">
                  {t("onboarding.rehaul.setupChoice.local.badge")}
                </span>
              </div>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <h2 className="onboarding-card-title text-[var(--onboarding-text-primary)]">
                    {t("onboarding.rehaul.setupChoice.local.title")}
                  </h2>
                  <p className="text-sm leading-[1.4] text-[var(--onboarding-text-secondary)]">
                    {t("onboarding.rehaul.setupChoice.local.description", {
                      minimumSpace: localSpaceGb,
                    })}
                  </p>
                </div>
                {/* The four marks are the icon-set equivalents of the glyphs the
                    Figma assets were exported from. */}
                <ul className="flex flex-col gap-2">
                  <Feature icon={Laptop}>
                    {t("onboarding.rehaul.setupChoice.local.features.device")}
                  </Feature>
                  <Feature icon={WifiOff}>
                    {t("onboarding.rehaul.setupChoice.local.features.offline")}
                  </Feature>
                  <Feature icon={GalleryVerticalEnd}>
                    {t("onboarding.rehaul.setupChoice.local.features.setup")}
                  </Feature>
                  <Feature icon={BanknoteCheck}>
                    {t("onboarding.rehaul.setupChoice.local.features.free")}
                  </Feature>
                </ul>
              </div>
            </div>
            {/* Straight to the local setup step: it shows what will download, how
                big it is and how fast it will feel before anything starts. */}
            <CardAction onClick={() => onSelect("local")}>
              {t("onboarding.rehaul.setupChoice.local.download")}
            </CardAction>
          </SetupCard>
        )}

        {cloudAllowed && (
          <SetupCard>
            {/* "Vector 1": a 343x183 wash pinned to the bottom of the cloud card.
                Approximated with a gradient — the Figma vector was not exported. */}
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-[183px] bg-gradient-to-t from-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] to-transparent"
              aria-hidden="true"
            />
            <div className="relative z-10 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                {/* Frame 48: 40px mark on the brand gradient. */}
                <span className="flex size-9 items-center justify-center rounded-full bg-gradient-to-b from-[#4079ed] to-[#244587] text-white">
                  <BrandMark className="size-6" />
                </span>
                {/* Frame 49: the "Recommended" chip. Figma has white text on a
                    glass fill over the card's background artwork ("Vector 1",
                    which was not exported) — on plain white that would be
                    invisible, so it takes the brand fill until the art lands. */}
                <span className="rounded-[47px] bg-[var(--onboarding-accent)] px-[9px] py-1 text-[10px] leading-[1.4] text-[var(--onboarding-accent-foreground)]">
                  {t("common.recommended")}
                </span>
              </div>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <h2 className="onboarding-card-title text-[var(--onboarding-text-primary)]">
                    {t("onboarding.rehaul.setupChoice.cloud.title")}
                  </h2>
                  <p className="text-sm leading-[1.4] text-[var(--onboarding-text-secondary)]">
                    {t("onboarding.rehaul.setupChoice.cloud.description")}
                  </p>
                </div>
                <ul className="flex flex-col gap-2">
                  <Feature icon={Zap} accent>
                    {t("onboarding.rehaul.setupChoice.cloud.features.fast")}
                  </Feature>
                  <Feature icon={ShieldCheck} accent>
                    {t("onboarding.rehaul.setupChoice.cloud.features.privacy")}
                  </Feature>
                  <Feature icon={MonitorSmartphone} accent>
                    {t("onboarding.rehaul.setupChoice.cloud.features.sync")}
                  </Feature>
                  <Feature icon={WandSparkles} accent>
                    {t("onboarding.rehaul.setupChoice.cloud.features.features")}
                  </Feature>
                </ul>
              </div>
            </div>
            <CardAction brand onClick={chooseCloud}>
              {isSignedIn
                ? t("onboarding.rehaul.setupChoice.cloud.continue")
                : t("onboarding.rehaul.setupChoice.cloud.signIn")}
            </CardAction>
          </SetupCard>
        )}
      </div>

      {/* Frame 25: BYOK and self-hosted are not cards in the spec — they live
          behind this pill, which opens the "Choose your API setup" modal. Hidden
          entirely when policy disallows both options. */}
      {moreOptionsAllowed && (
        <button
          type="button"
          onClick={() => setShowMore(true)}
          className="onboarding-pressable rounded-[38px] border border-[var(--onboarding-control-border)] px-4 py-1.5 text-xs font-medium leading-[1.4] text-[var(--onboarding-text-primary)] hover:bg-[var(--onboarding-surface-hover)]"
        >
          {t("onboarding.rehaul.setupChoice.showMore")}
        </button>
      )}

      {/* Figma "Frame 2147258999": 460 wide, radius 28, pad 24/20/32/20, col gap
          32, over a 20% black scrim at backdrop-blur(11). Picking a row goes
          straight to that setup step. */}
      <Dialog open={showMore} onOpenChange={(open) => !open && setShowMore(false)}>
        <DialogContent
          overlayClassName="bg-[var(--onboarding-scrim)]! backdrop-blur-[11px]"
          className="w-full max-w-sm gap-6 rounded-3xl border-0 bg-[var(--onboarding-surface)] px-4 pb-6 pt-5 text-start [&>button]:hidden"
        >
          {/* Frame 2147258979: 238 tall, radius 20, image fill. Source is 840x477,
              so it lands at ~2x for the 420x238 slot. */}
          <div
            className="flex h-[190px] items-center justify-center rounded-2xl bg-cover bg-center"
            style={{ backgroundImage: `url(${apiSetupHero})` }}
          >
            {/* Frame 35: pad 10 20, gap 7, radius 38, 16/140% medium. */}
            <span className="inline-flex items-center gap-1.5 rounded-[38px] border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-2 text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)]">
              <KeyRound
                className="size-5 shrink-0 text-[var(--onboarding-accent)]"
                strokeWidth={1.667}
              />
              {/* Illustrative sample, not copy — deliberately not translated. */}
              sk*********Jkn
            </span>
          </div>

          {/* Frame 2147259001: col gap 20. */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-2 text-center">
              {/* Important modifiers are load-bearing: DialogTitle renders an h2, and both
                  its own shadcn classes and the global h1–h6 rule set weight 600 and a
                  tighter tracking that a plain utility loses to. */}
              <DialogTitle className="text-xl! font-medium! leading-[1.4]! tracking-normal! text-[var(--onboarding-text-primary)]">
                {t("onboarding.rehaul.setupChoice.moreOptions.title")}
              </DialogTitle>
              <DialogDescription className="w-full max-w-xs text-sm leading-[1.4] text-[var(--onboarding-text-secondary)]">
                {t("onboarding.rehaul.setupChoice.moreOptions.description")}
              </DialogDescription>
            </div>

            {/* Frame 16: pad 20 16, surface-secondary, radius 20. Rows follow the
                shared rhythm — nothing above the first, divider between. */}
            <div className="rounded-2xl bg-[var(--onboarding-surface-secondary)] px-3.5 py-4">
              {moreSetupOptions.map((row, index) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => {
                    setShowMore(false);
                    // Both rows land on the BYOK step; self-hosted differs only in
                    // starting it with the self-hosted field set on.
                    onSelect("byok", { selfHosted: row.id === "self-hosted" });
                  }}
                  className={`onboarding-pressable flex w-full items-center gap-[14px] text-start ${
                    index === 0 ? "pb-4" : "border-t border-[var(--onboarding-control-border)] pt-4"
                  }`}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full border-[1.47px] border-[var(--onboarding-control-border)] text-[var(--onboarding-accent)]">
                    <row.icon className="size-[18px]" strokeWidth={1.667} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)]">
                      {row.title}
                    </span>
                    <span className="text-sm leading-[1.4] text-[var(--onboarding-text-secondary)]">
                      {row.description}
                    </span>
                  </span>
                  {/* Frame 25: 32px surface-tertiary disc with a tertiary chevron. */}
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--onboarding-surface-tertiary)] text-[var(--onboarding-text-tertiary)]">
                    <ChevronRight className="size-4 rtl:rotate-180" strokeWidth={1.667} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

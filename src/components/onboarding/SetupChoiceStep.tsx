import { useState } from "react";
import {
  Building2,
  ChevronRight,
  KeyRound,
  Laptop,
  MonitorSmartphone,
  Server,
  ShieldCheck,
  WandSparkles,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { isModeAllowedByPolicy } from "../../stores/policyRules";
import { getParakeetModelInfo } from "../../models/ModelRegistry";
import type { OnboardingSetupMode } from "./flow";
import { BrandMark } from "./OnboardingShell";
import openAIIcon from "../../assets/icons/providers/openai.svg";
import nvidiaIcon from "../../assets/icons/providers/nvidia.svg";
import warningBackdrop from "../../assets/onboarding-setup-motion.webp";

type SetupMode = Exclude<OnboardingSetupMode, null>;
type AdvancedSetupMode = Exclude<SetupMode, "cloud">;

const REFERENCE_LOCAL_MODEL_ID = "nemotron-3.5-asr-streaming-0.6b";

interface SetupChoiceStepProps {
  isSignedIn: boolean;
  onSelect: (mode: SetupMode) => void;
  onRequestAuthentication: () => void;
}

function CloudFeature({ icon: Icon, children }: { icon: typeof Zap; children: string }) {
  return (
    <li className="flex items-center gap-2 text-xs text-neutral-950">
      <Icon className="size-3.5 shrink-0 text-blue-500" />
      {children}
    </li>
  );
}

export default function SetupChoiceStep({
  isSignedIn,
  onSelect,
  onRequestAuthentication,
}: SetupChoiceStepProps) {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const [pending, setPending] = useState<AdvancedSetupMode | null>(null);

  const localReferenceModel = getParakeetModelInfo(REFERENCE_LOCAL_MODEL_ID);
  const localModelSize = (localReferenceModel?.size ?? t("common.unknown")).replace(
    /(\d)([A-Za-z])/,
    "$1 $2"
  );
  const minimumLocalSpaceGb = Math.max(1, Math.ceil((localReferenceModel?.sizeMb ?? 0) / 1000));

  const choices = [
    {
      id: "byok" as const,
      icon: KeyRound,
      title: t("onboarding.rehaul.setupChoice.byok.title"),
      description: t("onboarding.rehaul.setupChoice.byok.description"),
      allowed:
        isModeAllowedByPolicy(policy, "transcription", "providers") &&
        isModeAllowedByPolicy(policy, "llm", "providers"),
    },
    {
      id: "local" as const,
      icon: Laptop,
      title: t("onboarding.rehaul.setupChoice.local.title"),
      description: t("onboarding.rehaul.setupChoice.local.description", {
        minimumSpace: minimumLocalSpaceGb,
      }),
      allowed:
        isModeAllowedByPolicy(policy, "transcription", "local") &&
        isModeAllowedByPolicy(policy, "llm", "local"),
    },
    {
      id: "enterprise" as const,
      icon: Building2,
      title: t("onboarding.rehaul.setupChoice.enterprise.title"),
      description: t("onboarding.rehaul.setupChoice.enterprise.description"),
      allowed: isModeAllowedByPolicy(policy, "llm", "enterprise"),
    },
  ].filter((choice) => choice.allowed);

  const cloudAllowed =
    isModeAllowedByPolicy(policy, "transcription", "openwhispr") &&
    isModeAllowedByPolicy(policy, "llm", "openwhispr");

  const chooseCloud = () => {
    if (isSignedIn) onSelect("cloud");
    else onRequestAuthentication();
  };

  const confirmPending = () => {
    if (!pending) return;
    onSelect(pending);
    setPending(null);
  };

  const warningSteps = pending
    ? [1, 2, 3].map((step) =>
        t(`onboarding.rehaul.setupChoice.warnings.${pending}.steps.${step}`, {
          modelSize: localModelSize,
        })
      )
    : [];
  const WarningPrimaryIcon =
    pending === "byok" ? KeyRound : pending === "enterprise" ? Building2 : Laptop;

  return (
    <div
      className={`mx-auto mt-8 grid h-80 w-full gap-3.5 ${
        cloudAllowed
          ? "max-w-[39rem] grid-cols-[minmax(0,1fr)_minmax(0,1.23fr)]"
          : "max-w-[21rem] grid-cols-1"
      }`}
    >
      {cloudAllowed && (
        <section className="relative flex h-80 min-w-0 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-gradient-to-br from-white via-white to-blue-50 p-3.5 text-left">
          <span className="absolute right-3.5 top-5 rounded-full bg-gradient-to-r from-blue-600 to-violet-500 px-2 py-1 text-[9px] text-white">
            {t("common.recommended")}
          </span>
          <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-400 to-blue-800 text-white shadow-sm">
            <BrandMark className="size-6" />
          </span>
          <h2 className="mt-5 text-sm font-semibold text-neutral-950">
            {t("onboarding.rehaul.setupChoice.cloud.title")}
          </h2>
          <p className="mt-2 text-sm leading-5 text-neutral-500">
            {t("onboarding.rehaul.setupChoice.cloud.description")}
          </p>
          <ul className="mt-5 flex-1 space-y-3">
            <CloudFeature icon={Zap}>
              {t("onboarding.rehaul.setupChoice.cloud.features.fast")}
            </CloudFeature>
            <CloudFeature icon={ShieldCheck}>
              {t("onboarding.rehaul.setupChoice.cloud.features.privacy")}
            </CloudFeature>
            <CloudFeature icon={MonitorSmartphone}>
              {t("onboarding.rehaul.setupChoice.cloud.features.sync")}
            </CloudFeature>
            <CloudFeature icon={WandSparkles}>
              {t("onboarding.rehaul.setupChoice.cloud.features.features")}
            </CloudFeature>
          </ul>
          <Button
            type="button"
            onClick={chooseCloud}
            className="h-8 w-full rounded-full bg-blue-500 text-xs text-white hover:bg-blue-600"
          >
            {isSignedIn
              ? t("onboarding.rehaul.setupChoice.cloud.continue")
              : t("onboarding.rehaul.setupChoice.cloud.signIn")}
          </Button>
        </section>
      )}

      <div className="grid h-80 min-w-0 grid-rows-3 gap-3.5">
        {choices.map(({ id, icon: Icon, title, description }) => (
          <button
            key={id}
            type="button"
            onClick={() => setPending(id)}
            className="group relative flex min-h-0 min-w-0 w-full flex-col items-start justify-center rounded-2xl border border-neutral-200 bg-white p-3 text-left transition-colors hover:border-blue-300"
          >
            {id === "local" ? (
              <span className="mb-2 flex -space-x-1.5">
                <span className="flex size-7 items-center justify-center rounded-full bg-neutral-950 ring-2 ring-white">
                  <img src={openAIIcon} alt="" className="size-4 invert" />
                </span>
                <span className="flex size-7 items-center justify-center rounded-full bg-lime-500 ring-2 ring-white">
                  <img src={nvidiaIcon} alt="" className="size-5" />
                </span>
              </span>
            ) : (
              <span className="mb-2 flex size-7 items-center justify-center rounded-full border border-neutral-200 bg-white text-blue-500">
                <Icon className="size-3.5" />
              </span>
            )}
            <span className="text-sm font-medium text-neutral-950">{title}</span>
            <span className="mt-1 block truncate text-xs text-neutral-500">{description}</span>
            <ChevronRight className="absolute right-3 top-5 size-4 text-neutral-400 transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent
          overlayClassName="bg-neutral-400/50! backdrop-blur-sm"
          className="top-[45%] max-w-[23rem] gap-0 rounded-3xl border-0 bg-white p-4 text-neutral-950 shadow-2xl dark:bg-white [&>button]:hidden"
        >
          <div
            className="relative h-48 overflow-hidden rounded-2xl bg-cover bg-center"
            style={{ backgroundImage: `url(${warningBackdrop})` }}
          >
            <div className="absolute inset-0 bg-neutral-950/10" />
            <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-full bg-white/60 text-neutral-600 backdrop-blur-sm">
                <KeyRound className="size-4" />
              </span>
              <span className="flex size-14 items-center justify-center rounded-full border border-neutral-300 bg-white text-blue-500 shadow-lg">
                <WarningPrimaryIcon className="size-6" />
              </span>
              <span className="flex size-8 items-center justify-center rounded-full bg-white/60 text-neutral-600 backdrop-blur-sm">
                <Server className="size-4" />
              </span>
            </div>
          </div>

          <DialogTitle className="mt-7 text-lg font-semibold leading-6 text-neutral-950">
            {pending ? t(`onboarding.rehaul.setupChoice.warnings.${pending}.title`) : ""}
          </DialogTitle>
          <DialogDescription className="mt-2 text-xs leading-4 text-neutral-500">
            {pending
              ? t(`onboarding.rehaul.setupChoice.warnings.${pending}.description`, {
                  minimumSpace: minimumLocalSpaceGb,
                })
              : ""}
          </DialogDescription>

          <ol className="mt-5 space-y-5">
            {warningSteps.map((step, index) => (
              <li key={step} className="flex items-center gap-2.5 text-xs text-neutral-950">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-950 text-white">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>

          <div className="mt-6 grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline-flat"
              onClick={confirmPending}
              className={`h-8 rounded-full border border-neutral-200 bg-white text-xs text-neutral-950 ${
                cloudAllowed ? "" : "col-span-2"
              }`}
            >
              {pending
                ? t(`onboarding.rehaul.setupChoice.warnings.${pending}.continue`)
                : t("onboarding.rehaul.setupChoice.continueSetup")}
            </Button>
            {cloudAllowed && (
              <Button
                type="button"
                onClick={() => {
                  setPending(null);
                  chooseCloud();
                }}
                className="h-8 rounded-full bg-blue-500 text-xs text-white hover:bg-blue-600"
              >
                {t("onboarding.rehaul.setupChoice.useCloud")}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

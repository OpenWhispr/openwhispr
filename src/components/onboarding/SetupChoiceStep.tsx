import { useState } from "react";
import { Building2, Check, ChevronRight, Cloud, KeyRound, Laptop } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { isModeAllowedByPolicy } from "../../stores/policyRules";
import type { OnboardingSetupMode } from "./flow";

interface SetupChoiceStepProps {
  isSignedIn: boolean;
  onSelect: (mode: Exclude<OnboardingSetupMode, null>) => void;
  onRequestAuthentication: () => void;
}

export default function SetupChoiceStep({
  isSignedIn,
  onSelect,
  onRequestAuthentication,
}: SetupChoiceStepProps) {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const [pending, setPending] = useState<Exclude<OnboardingSetupMode, null | "cloud"> | null>(null);

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
      description: t("onboarding.rehaul.setupChoice.local.description"),
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

  const confirmPending = () => {
    if (!pending) return;
    onSelect(pending);
    setPending(null);
  };

  return (
    <div className="mx-auto mt-10 grid w-full max-w-5xl gap-5 lg:grid-cols-[1.2fr_1fr]">
      {cloudAllowed && (
        <section className="relative overflow-hidden rounded-3xl border border-primary/30 bg-primary/5 p-7 shadow-lg md:p-9">
          <div className="absolute right-6 top-6 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">
            {t("common.recommended")}
          </div>
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Cloud className="size-6" />
          </div>
          <h2 className="mt-6 text-2xl font-medium text-foreground">
            {t("onboarding.rehaul.setupChoice.cloud.title")}
          </h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            {t("onboarding.rehaul.setupChoice.cloud.description")}
          </p>
          <ul className="mt-6 space-y-3">
            {["fast", "privacy", "sync", "features"].map((item) => (
              <li key={item} className="flex items-center gap-3 text-sm text-foreground">
                <span className="flex size-5 items-center justify-center rounded-full bg-success/10 text-success">
                  <Check className="size-3" />
                </span>
                {t(`onboarding.rehaul.setupChoice.cloud.features.${item}`)}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            onClick={() => (isSignedIn ? onSelect("cloud") : onRequestAuthentication())}
            className="mt-8 w-full rounded-full"
          >
            {isSignedIn
              ? t("onboarding.rehaul.setupChoice.cloud.continue")
              : t("onboarding.rehaul.setupChoice.cloud.signIn")}
          </Button>
        </section>
      )}

      <div className="space-y-4">
        {choices.map(({ id, icon: Icon, title, description }) => (
          <button
            key={id}
            type="button"
            onClick={() => setPending(id)}
            className="group flex w-full items-center gap-4 rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition-[border-color,transform] hover:-translate-y-0.5 hover:border-primary/40"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
              <Icon className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{title}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {description}
              </span>
            </span>
            <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <div className="onboarding-code-hero h-36 rounded-2xl border border-border" />
          <DialogHeader>
            <DialogTitle>
              {pending ? t(`onboarding.rehaul.setupChoice.warnings.${pending}.title`) : ""}
            </DialogTitle>
            <DialogDescription>
              {pending ? t(`onboarding.rehaul.setupChoice.warnings.${pending}.description`) : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPending(null)}>
              {t("onboarding.rehaul.setupChoice.useCloud")}
            </Button>
            <Button type="button" onClick={confirmPending}>
              {t("onboarding.rehaul.setupChoice.continueSetup")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

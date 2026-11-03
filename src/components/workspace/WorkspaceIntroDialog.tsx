import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Building2, Check, ChevronDown, Plus, User, Users } from "../icons";
import { cn } from "../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import workspaceImage from "../../assets/workspace-intro-workspace.webp";
import teamspacesImage from "../../assets/workspace-intro-teamspaces.webp";
import teamsImage from "../../assets/workspace-intro-teams.webp";

type IntroStepId = "workspace" | "teamspaces" | "teams";

export const WORKSPACE_INTRO_STEPS: ReadonlyArray<{ id: IntroStepId; image: string }> = [
  { id: "workspace", image: workspaceImage },
  { id: "teamspaces", image: teamspacesImage },
  { id: "teams", image: teamsImage },
];

const MOCK_CARD =
  "absolute overflow-hidden rounded-xl border border-border bg-surface-1 text-start shadow-[0_4px_10px_rgba(0,0,0,0.12)]";
const MOCK_ICON =
  "flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-foreground";
const PILL_BUTTON =
  "flex h-10 items-center justify-center gap-2 rounded-full text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function WorkspaceMock({ workspaceName }: { workspaceName: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <div className={cn(MOCK_CARD, "bottom-[90px] left-1/2 w-[254px] -translate-x-1/2")}>
        <div className="flex items-center gap-3 p-3">
          <span className={MOCK_ICON}>
            <Building2 size={16} />
          </span>
          <span dir="auto" className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {workspaceName}
          </span>
          <Check size={16} className="shrink-0 text-primary" />
        </div>
        <div className="flex items-center gap-2 border-t border-border p-3">
          <span className={MOCK_ICON}>
            <User size={16} />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {t("notes.spaces.personal")}
          </span>
        </div>
      </div>
      <div
        className={cn(
          MOCK_CARD,
          "bottom-[70px] left-[calc(50%+97px)] flex -translate-x-1/2 items-center gap-1 border-border-hover py-1.5 ps-1 pe-3.5"
        )}
      >
        <span className="flex p-1.5 text-muted-foreground">
          <Plus size={16} />
        </span>
        <span className="whitespace-nowrap text-base font-medium text-muted-foreground">
          {t("workspaces.switcher.add")}
        </span>
      </div>
    </>
  );
}

function SkeletonRow(): ReactElement {
  return (
    <div className="flex flex-col gap-1.5 py-1">
      <span className="h-2.5 w-28 rounded-full bg-foreground/15" />
      <span className="h-2 w-12 rounded-full bg-foreground/8" />
    </div>
  );
}

function TeamspacesMock({ workspaceName }: { workspaceName: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        MOCK_CARD,
        "left-1/2 top-[calc(50%+12px)] w-[312px] -translate-x-1/2 -translate-y-1/2"
      )}
    >
      <div className="flex items-center gap-3 p-3">
        <span className={MOCK_ICON}>
          <Building2 size={16} />
        </span>
        <span dir="auto" className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {workspaceName}
        </span>
        <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-3 py-3 ps-[52px] pe-3">
        <span className="truncate text-sm font-medium text-foreground">
          {t("notes.spaces.personal")}
        </span>
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </div>
  );
}

function TeamsMock(): ReactElement {
  const avatar =
    "-me-1.5 flex size-[22px] items-center justify-center rounded-full border border-surface-1";
  return (
    <div className="absolute left-1/2 top-[132px] flex h-[54px] -translate-x-1/2 items-center gap-3 rounded-[20px] border border-primary/60 bg-gradient-to-b from-surface-1 to-primary/10 px-5 shadow-[0_5px_12px_rgba(0,0,0,0.12)]">
      <span className="flex items-center">
        <span className={cn(avatar, "bg-primary/20 text-primary")}>
          <User size={12} />
        </span>
        <span className={cn(avatar, "bg-primary/35 text-primary")}>
          <User size={12} />
        </span>
        <span className={cn(avatar, "bg-surface-3 text-[10px] font-medium text-primary")}>+2</span>
      </span>
      <Users size={22} className="text-primary" />
    </div>
  );
}

export interface WorkspaceIntroCardProps {
  step: number;
  workspaceName: string;
  onNext: () => void;
  onFinish: () => void;
}

/** One step of the intro; rendered inside the dialog, which owns the step. */
export function WorkspaceIntroCard({
  step,
  workspaceName,
  onNext,
  onFinish,
}: WorkspaceIntroCardProps): ReactElement {
  const { t } = useTranslation();
  const { id, image } = WORKSPACE_INTRO_STEPS[step];
  const total = WORKSPACE_INTRO_STEPS.length;
  const isLast = step === total - 1;

  return (
    <>
      <div className="relative h-[320px] w-full overflow-hidden">
        <img
          src={image}
          alt=""
          aria-hidden="true"
          width={500}
          height={320}
          decoding="async"
          draggable={false}
          className="pointer-events-none absolute inset-0 size-full object-cover"
        />
        <div aria-hidden="true">
          {id === "workspace" && <WorkspaceMock workspaceName={workspaceName} />}
          {id === "teamspaces" && <TeamspacesMock workspaceName={workspaceName} />}
          {id === "teams" && <TeamsMock />}
        </div>
      </div>

      <div className="flex flex-col gap-[30px] p-7">
        <div className="flex flex-col gap-2 text-start">
          <DialogTitle className="text-lg font-medium leading-[1.4] tracking-normal">
            {t(`workspaces.intro.${id}.title`)}
          </DialogTitle>
          <DialogDescription className="text-sm leading-normal text-muted-foreground">
            {t(`workspaces.intro.${id}.body`)}
          </DialogDescription>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div
            role="img"
            aria-label={t("workspaces.intro.progress", { current: step + 1, total })}
            className="flex items-center gap-2 p-2.5"
          >
            {WORKSPACE_INTRO_STEPS.map((introStep, index) => (
              <span
                key={introStep.id}
                data-intro-progress={index === step ? "active" : "inactive"}
                className={cn(
                  "h-1 w-[15px] rounded-full",
                  index <= step ? "bg-primary" : "bg-surface-3"
                )}
              />
            ))}
          </div>

          <div className="flex items-center gap-1">
            {!isLast && (
              <button
                type="button"
                onClick={onFinish}
                className={cn(PILL_BUTTON, "px-4 text-muted-foreground hover:text-foreground")}
              >
                {t("common.skip")}
              </button>
            )}
            {/* Radix would focus Skip, the first control, so a stray Enter would end the tour. */}
            <button
              type="button"
              autoFocus
              onClick={isLast ? onFinish : onNext}
              className={cn(
                PILL_BUTTON,
                "bg-primary px-5 text-primary-foreground hover:bg-primary/90"
              )}
            >
              {isLast ? t("workspaces.intro.getStarted") : t("common.next")}
              <ArrowRight size={14} className="rtl:rotate-180" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Mounted only while the dialog is open, and keyed by workspace, so every opening starts on step 1.
function IntroSteps({
  workspaceName,
  onFinish,
}: {
  workspaceName: string;
  onFinish: () => void;
}): ReactElement {
  const [step, setStep] = useState(0);
  return (
    <WorkspaceIntroCard
      step={step}
      workspaceName={workspaceName}
      onNext={() => setStep((current) => Math.min(current + 1, WORKSPACE_INTRO_STEPS.length - 1))}
      onFinish={onFinish}
    />
  );
}

export function WorkspaceIntroDialog({
  open,
  workspaceId,
  workspaceName,
  onFinish,
}: {
  open: boolean;
  workspaceId: string;
  workspaceName: string;
  /** Called with the workspace the steps were shown for, so a switch mid-intro marks the right one. */
  onFinish: (workspaceId: string) => void;
}): ReactElement {
  const finish = (): void => onFinish(workspaceId);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Esc and the overlay count as Skip.
        if (!nextOpen) finish();
      }}
    >
      <DialogContent
        hideCloseButton
        // Scrolls on short windows so Next and Get started stay reachable.
        className="max-h-[calc(100vh-32px)] w-[500px] max-w-[calc(100vw-32px)] gap-0 overflow-y-auto overflow-x-hidden rounded-[28px] p-0 sm:max-w-[500px]"
      >
        <IntroSteps key={workspaceId} workspaceName={workspaceName} onFinish={finish} />
      </DialogContent>
    </Dialog>
  );
}

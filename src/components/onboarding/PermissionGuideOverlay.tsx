import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "../icons";
import type { PermissionGuideAction, PermissionGuideState } from "../../types/permissionGuide";

interface CardProps {
  state: PermissionGuideState;
  onAction: (action: PermissionGuideAction["action"]) => void;
  onDrag: () => void;
}

export function PermissionGuideCard({ state, onAction, onDrag }: CardProps): ReactElement {
  const { t } = useTranslation();
  const instructions = {
    microphone: t("onboarding.permissionGuide.microphone"),
    accessibility: t("onboarding.permissionGuide.accessibility"),
    "system-audio": t("onboarding.permissionGuide.systemAudio"),
    "screen-context": t("onboarding.permissionGuide.screenContext"),
  };
  const dragStep =
    !state.granted &&
    (state.permission === "accessibility" || state.permission === "screen-context");
  const interactive = { WebkitAppRegion: "no-drag" } as CSSProperties;
  const button =
    "rounded-full px-3 py-1.5 text-xs font-medium hover:bg-[var(--onboarding-surface-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onboarding-accent)] disabled:opacity-50";

  return (
    <section
      className="permission-settings-overlay onboarding-canvas flex h-screen items-center gap-3 overflow-y-auto rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-3 text-[var(--onboarding-text-primary)]"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
      aria-label={t("onboarding.permissionGuide.label")}
    >
      <button
        type="button"
        className={`${button} shrink-0 p-2! bg-[var(--onboarding-surface-tertiary)]`}
        style={interactive}
        onClick={() => onAction("close")}
        aria-label={t("onboarding.permissionGuide.return")}
      >
        <ChevronLeft className="size-4 rtl:rotate-180" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm leading-5" aria-live="polite">
          {dragStep && (
            <span
              aria-hidden="true"
              className="text-3xl leading-none text-[var(--onboarding-accent)]"
            >
              ↑
            </span>
          )}
          <span>
            {state.needsRelaunch
              ? t("onboarding.permissionGuide.restartRequired")
              : instructions[state.permission]}
          </span>
        </p>
        {dragStep && (
          <div
            draggable={Boolean(state.canDrag)}
            onDragStart={(event) => {
              event.preventDefault();
              if (state.canDrag) onDrag();
            }}
            style={interactive}
            aria-disabled={!state.canDrag}
            className={`mt-2 flex items-center gap-2.5 rounded-lg border border-[var(--onboarding-control-border)] px-3 py-2 ${state.canDrag ? "cursor-grab active:cursor-grabbing" : "opacity-60"}`}
          >
            {state.appIcon && (
              <img src={state.appIcon} alt="" draggable={false} className="size-7" />
            )}
            <span className="text-sm font-medium">OpenWhispr</span>
            <span className="ms-auto text-[11px] text-[var(--onboarding-text-secondary)]">
              {t("onboarding.permissionGuide.missingApp")}
            </span>
          </div>
        )}
        {(state.permission === "system-audio" || state.needsRelaunch || state.error) && (
          <div className="mt-2 flex items-center justify-end gap-2" style={interactive}>
            {state.error && (
              <span role="alert" className="me-auto text-xs text-warning">
                {t("onboarding.permissionGuide.failed")}
              </span>
            )}
            {state.error && (
              <button
                type="button"
                className={button}
                disabled={state.busy}
                onClick={() => onAction("settings")}
              >
                {t("onboarding.permissionGuide.settings")}
              </button>
            )}
            <button
              type="button"
              className={`${button} bg-[var(--onboarding-accent)] text-white`}
              disabled={state.busy}
              onClick={() => onAction(state.needsRelaunch ? "restart" : "check")}
            >
              {state.busy
                ? t("common.loading")
                : state.needsRelaunch
                  ? t("onboarding.permissionGuide.restart")
                  : t("onboarding.permissionGuide.check")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export function PermissionGuideOverlay(): ReactElement | null {
  const [state, setState] = useState<PermissionGuideState | null>(null);
  useEffect(() => {
    let disposed = false;
    let received = false;
    const unsubscribe = window.electronAPI.onPermissionGuideState?.((next) => {
      received = true;
      setState(next);
    });
    void window.electronAPI.getPermissionGuideState?.().then((initial) => {
      if (!disposed && !received && initial) setState(initial);
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const sessionId = state?.sessionId;
  const permission = state?.permission;
  useEffect(() => {
    if (!sessionId || !permission) return;
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape")
        window.electronAPI.permissionGuideAction?.({ sessionId, permission, action: "close" });
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [sessionId, permission]);

  if (!state) return null;
  const target = { sessionId: state.sessionId, permission: state.permission };
  return (
    <PermissionGuideCard
      state={state}
      onAction={(action) => window.electronAPI.permissionGuideAction?.({ ...target, action })}
      onDrag={() => window.electronAPI.startPermissionGuideDrag?.(target)}
    />
  );
}

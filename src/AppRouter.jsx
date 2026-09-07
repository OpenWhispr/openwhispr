import React, { Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import App from "./App.jsx";
import AgentDictationPillOverlay from "./components/dictation/AgentDictationPillOverlay.tsx";
import MeetingNotificationOverlay from "./components/MeetingNotificationOverlay.tsx";
import ReauthenticationScreen from "./components/ReauthenticationScreen.tsx";
import UpdateNotificationOverlay from "./components/UpdateNotificationOverlay.tsx";
import BackgroundModelDownloadTray from "./components/onboarding/BackgroundModelDownloadTray.tsx";
import { LEGACY_ONBOARDING_STEP_KEY, ONBOARDING_SESSION_KEY } from "./components/onboarding/flow";
import { useAuth } from "./hooks/useAuth";
import { useTheme } from "./hooks/useTheme";
import { usePolicyStore } from "./stores/policyStore";
import { resolveSettledControlPanelWindowMode } from "./utils/controlPanelWindowMode.ts";
import { isControlPanelWindow } from "./utils/windowContext.ts";

// Either marker means the flow is mid-way: the legacy step key is kept for
// back-compat, the v2 session is what the rebuilt flow actually persists.
const isOnboardingInProgress = () =>
  localStorage.getItem(LEGACY_ONBOARDING_STEP_KEY) !== null ||
  localStorage.getItem(ONBOARDING_SESSION_KEY) !== null;

const ControlPanel = React.lazy(() => import("./components/ControlPanel.tsx"));
const OnboardingFlow = React.lazy(() => import("./components/OnboardingFlow.tsx"));

export default function AppRouter() {
  useTheme();
  const params = window.location.search;

  if (params.includes("meeting-notification=true")) {
    return <MeetingNotificationOverlay />;
  }

  if (params.includes("update-notification=true")) {
    return <UpdateNotificationOverlay />;
  }

  if (params.includes("agent-dictation-pill=true")) {
    return <AgentDictationPillOverlay />;
  }

  return <MainApp />;
}

function MainApp() {
  const { isSignedIn, isGracePeriodOnly, isLoaded: authLoaded } = useAuth();
  const policyStatus = usePolicyStore((state) => state.status);
  const policyResolved =
    !isSignedIn ||
    policyStatus === "managed" ||
    policyStatus === "unmanaged" ||
    policyStatus === "error";
  const isWaitingForPolicyStart = isSignedIn && !policyResolved;
  const autoSyncReady = authLoaded && policyResolved;

  const [showOnboarding, setShowOnboarding] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [postOnboardingSettingsSection, setPostOnboardingSettingsSection] = useState(undefined);

  const isControlPanel = isControlPanelWindow();
  const isDictationPanel = !isControlPanel;

  useEffect(() => {
    if (isControlPanel) {
      import("./components/ControlPanel.tsx").catch(() => {});

      if (!localStorage.getItem("onboardingCompleted")) {
        import("./components/OnboardingFlow.tsx").catch(() => {});
      }
    }

    // Sync starts only after auth settles, so a new bearer token cannot touch
    // the previous account's rows while validation is still running. A failed
    // (guest/offline) resolution also counts as settled: canSync() then no-ops
    // because no validated auth context exists.
    if (autoSyncReady) {
      import("./services/SyncService.js")
        .then(({ syncService }) => syncService.startAutoSync())
        .catch(() => {});
    }
  }, [autoSyncReady, isControlPanel]);

  useEffect(() => {
    if (!authLoaded) return;

    const onboardingCompleted = localStorage.getItem("onboardingCompleted") === "true";
    const authSkipped =
      localStorage.getItem("authenticationSkipped") === "true" ||
      localStorage.getItem("skipAuth") === "true";
    const onboardingInProgress = isOnboardingInProgress();
    const isReturningUser =
      !onboardingCompleted && isSignedIn && !isGracePeriodOnly && !onboardingInProgress;

    if (isReturningUser) {
      localStorage.setItem("onboardingCompleted", "true");
    }

    const resolved = localStorage.getItem("onboardingCompleted") === "true";

    if (isControlPanel) {
      if (!resolved) {
        setShowOnboarding(true);
      } else if (!isSignedIn && !authSkipped) {
        setNeedsReauth(true);
      }
    }

    if (isDictationPanel && !resolved) {
      // Keep the dictation overlay hidden during onboarding — OnboardingFlow
      // shows it explicitly when the user reaches the activation step.
      window.electronAPI?.hideWindow?.();
    }

    setIsLoading(false);
  }, [authLoaded, isControlPanel, isDictationPanel, isGracePeriodOnly, isSignedIn]);

  useEffect(() => {
    if (!isControlPanel || !authLoaded) return;
    // Fast path: a user who already finished onboarding can never enter the
    // compact flow only when their session or guest choice is still valid.
    // Signed-out account users fall through so reauthentication can select the
    // compact window without first flashing restored control-panel dimensions.
    const completed = localStorage.getItem("onboardingCompleted") === "true";
    const authSkipped =
      localStorage.getItem("authenticationSkipped") === "true" ||
      localStorage.getItem("skipAuth") === "true";
    if (completed && !isOnboardingInProgress() && (isSignedIn || authSkipped)) {
      void window.electronAPI?.setOnboardingWindowMode?.("restore");
    }
  }, [authLoaded, isControlPanel, isSignedIn]);

  const settledControlPanelWindowMode = resolveSettledControlPanelWindowMode({
    isControlPanel,
    isLoading,
    isWaitingForPolicyStart,
    showOnboarding,
    needsReauth,
  });

  useEffect(() => {
    if (!settledControlPanelWindowMode) return;
    // The main process waits for this renderer decision before showing the
    // control panel, preventing a fresh install from flashing at 1200×800
    // before its route-appropriate window mode is applied.
    void window.electronAPI?.setOnboardingWindowMode?.(settledControlPanelWindowMode);
  }, [settledControlPanelWindowMode]);

  useEffect(() => {
    if (isLoading || isWaitingForPolicyStart) return;

    const onboardingCompleted = localStorage.getItem("onboardingCompleted") === "true";
    const normalAppVisible =
      onboardingCompleted && (!isControlPanel || (!showOnboarding && !needsReauth));
    // Main starts fail-closed. Only a renderer that has resolved the route and
    // actually committed the normal app may release global hotkeys and popup
    // surfaces; fresh installs and onboarding reloads keep them suppressed.
    void window.electronAPI?.setOnboardingActive?.(!normalAppVisible);
  }, [isControlPanel, isLoading, isWaitingForPolicyStart, needsReauth, showOnboarding]);

  const handleOnboardingComplete = (options) => {
    if (options?.openSettings) {
      setPostOnboardingSettingsSection("transcription");
    }
    setShowOnboarding(false);
    localStorage.setItem("onboardingCompleted", "true");
  };

  // isLoading clears once the onboarding effect has run, which itself waits
  // for authLoaded — and authLoaded terminates even when the session cannot
  // resolve (guest/offline presents as signed out).
  if (isLoading || isWaitingForPolicyStart) {
    return <LoadingFallback />;
  }

  if (isControlPanel && showOnboarding) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <OnboardingFlow onComplete={handleOnboardingComplete} />
        <BackgroundModelDownloadTray />
      </Suspense>
    );
  }

  if (isControlPanel && needsReauth) {
    return (
      <ReauthenticationScreen
        onContinueWithoutAccount={() => {
          localStorage.setItem("authenticationSkipped", "true");
          localStorage.setItem("skipAuth", "true");
          setNeedsReauth(false);
        }}
        onAuthComplete={() => setNeedsReauth(false)}
      />
    );
  }

  return isControlPanel ? (
    <Suspense fallback={<LoadingFallback />}>
      <ControlPanel initialSettingsSection={postOnboardingSettingsSection} />
      <BackgroundModelDownloadTray />
    </Suspense>
  ) : (
    <App />
  );
}

function LoadingFallback({ message }) {
  const { t } = useTranslation();
  const fallbackMessage = message || t("common.loading");

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 animate-[scale-in_300ms_ease-out]">
        <svg
          viewBox="0 0 1024 1024"
          className="w-12 h-12 drop-shadow-[0_2px_8px_rgba(37,99,235,0.18)] dark:drop-shadow-[0_2px_12px_rgba(100,149,237,0.25)]"
          aria-label="OpenWhispr"
        >
          <rect width="1024" height="1024" rx="241" fill="#2056DF" />
          <circle cx="512" cy="512" r="314" fill="#2056DF" stroke="white" strokeWidth="74" />
          <path d="M512 383V641" stroke="white" strokeWidth="74" strokeLinecap="round" />
          <path d="M627 457V568" stroke="white" strokeWidth="74" strokeLinecap="round" />
          <path d="M397 457V568" stroke="white" strokeWidth="74" strokeLinecap="round" />
        </svg>
        <div className="w-7 h-7 rounded-full border-[2.5px] border-transparent border-t-primary animate-[spinner-rotate_0.8s_cubic-bezier(0.4,0,0.2,1)_infinite] motion-reduce:animate-none motion-reduce:border-t-muted-foreground motion-reduce:opacity-50" />
        {fallbackMessage && (
          <p className="text-[13px] font-medium text-muted-foreground dark:text-foreground/60 tracking-[-0.01em]">
            {fallbackMessage}
          </p>
        )}
      </div>
    </div>
  );
}

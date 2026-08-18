import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import AppRouter from "./AppRouter.jsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import CleanupFailureToastListener from "./components/CleanupFailureToastListener.tsx";
import TinfoilModelSwitchToastListener from "./components/TinfoilModelSwitchToastListener.tsx";
import GpuPackMigrationToastListener from "./components/GpuPackMigrationToastListener.tsx";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { SettingsProvider } from "./hooks/useSettings";

import i18n from "./i18n";
// Self-hosted so it works offline and makes no network call — the "opsz" build
// carries Inter's optical-size axis, so large display text picks up the Inter
// Display shaping automatically. Declaring the face is global; only the
// onboarding surfaces actually ask for it (see .onboarding-canvas in index.css).
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/caveat";
import "./index.css";
import { isControlPanelWindow } from "./utils/windowContext.ts";

// Dev tooling (DialKit panel, onboarding flow jumper, Agentation toolbar).
// import.meta.env.DEV is statically false in a production build, so this whole
// branch — and every package it pulls in — is dropped from the shipped bundle.
// Control panel only: the dictation pill and overlay windows are too small and
// would each get their own copy of the toolbar.
const DevTools = import.meta.env.DEV ? React.lazy(() => import("./dev/DevTools.tsx")) : null;
const showDevTools = Boolean(DevTools) && isControlPanelWindow();

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nextProvider i18n={i18n}>
        <SettingsProvider>
          <ToastProvider>
            <TinfoilModelSwitchToastListener />
            <CleanupFailureToastListener />
            <GpuPackMigrationToastListener />
            <AppRouter />
          </ToastProvider>
        </SettingsProvider>
      </I18nextProvider>
    </ErrorBoundary>
    {/* Outside ErrorBoundary on purpose: a crash in dev tooling must not take
        down the real app. */}
    {showDevTools && (
      <React.Suspense fallback={null}>
        <DevTools />
      </React.Suspense>
    )}
  </React.StrictMode>
);

if (import.meta.hot) {
  import.meta.hot.accept();
}

import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import AppRouter from "./AppRouter.jsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import CleanupFailureToastListener from "./components/CleanupFailureToastListener.tsx";
import TinfoilModelSwitchToastListener from "./components/TinfoilModelSwitchToastListener.tsx";
import GpuPackMigrationToastListener from "./components/GpuPackMigrationToastListener.tsx";
import { I18nDirectionProvider } from "./components/I18nDirectionProvider.tsx";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { SettingsProvider } from "./hooks/useSettings";
import { bindDocumentLanguage } from "./utils/i18nDocument";

import i18n from "./i18n";
// Self-hosted so it works offline and makes no network call — the "opsz" build
// carries Inter's optical-size axis, so large display text picks up the Inter
// Display shaping automatically. Declaring the face is global; only the
// onboarding surfaces actually ask for it (see .onboarding-canvas in index.css).
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/caveat";
import "./index.css";

bindDocumentLanguage(i18n, document.documentElement, import.meta.hot);

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nextProvider i18n={i18n}>
        <I18nDirectionProvider>
          <SettingsProvider>
            <ToastProvider>
              <TinfoilModelSwitchToastListener />
              <CleanupFailureToastListener />
              <GpuPackMigrationToastListener />
              <AppRouter />
            </ToastProvider>
          </SettingsProvider>
        </I18nDirectionProvider>
      </I18nextProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

if (import.meta.hot) {
  import.meta.hot.accept();
}

import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import AppRouter from "./AppRouter.jsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { SettingsProvider } from "./hooks/useSettings";

import i18n from "./i18n";
import "./index.css";

let root = null;

const VALID_CHANNELS = new Set(["development", "staging", "production"]);
const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL = {
  development: "openwhispr-dev",
  staging: "openwhispr-staging",
  production: "openwhispr",
};
const inferredChannel = import.meta.env.DEV ? "development" : "production";
const configuredChannel = (import.meta.env.VITE_OPENWHISPR_CHANNEL || inferredChannel)
  .trim()
  .toLowerCase();
const APP_CHANNEL = VALID_CHANNELS.has(configuredChannel) ? configuredChannel : inferredChannel;
const defaultOAuthProtocol =
  DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL[APP_CHANNEL] || DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL.production;
const OAUTH_PROTOCOL = (import.meta.env.VITE_OPENWHISPR_PROTOCOL || defaultOAuthProtocol)
  .trim()
  .toLowerCase();
const OAUTH_AUTH_BRIDGE_URL = (import.meta.env.VITE_OPENWHISPR_AUTH_BRIDGE_URL || "").trim();

// OAuth callback handler: when the browser redirects back from Google/Neon Auth
// with a session verifier, redirect to the configured custom protocol so Electron
// can capture it and complete authentication. This check runs before React
// mounts — if we detect we're in the system browser with a verifier, we
// redirect immediately and skip mounting the app entirely.
function isOAuthBrowserRedirect() {
  const params = new URLSearchParams(window.location.search);
  const verifier = params.get("neon_auth_session_verifier");
  const isInElectron = typeof window.electronAPI !== "undefined";

  if (verifier && !isInElectron) {
    const redirectTitle = i18n.t("app.oauth.redirectTitle");
    const closeTab = i18n.t("app.oauth.closeTab");

    if (OAUTH_AUTH_BRIDGE_URL) {
      try {
        const bridgeUrl = new URL(OAUTH_AUTH_BRIDGE_URL);
        bridgeUrl.searchParams.set("neon_auth_session_verifier", verifier);
        window.location.replace(bridgeUrl.toString());
        return true;
      } catch {
        // Fall back to protocol redirect below.
      }
    }

    setTimeout(() => {
      window.location.href = `${OAUTH_PROTOCOL}://auth/callback?neon_auth_session_verifier=${encodeURIComponent(verifier)}`;
    }, 2000);

    document.body.innerHTML = `
      <style>
        /* Design tokens from index.css — single source of truth */
        :root {
          --bg: #ffffff;
          --surface-1: #fafafa;
          --surface-2: #ffffff;
          --border: #e5e5e5;
          --border-subtle: #e5e5e5;
          --text-primary: #171717;
          --text-muted: #737373;
          --primary: #2563eb;
          --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.08);
          --shadow-elevated: 0 8px 24px rgba(0, 0, 0, 0.12);
        }

        @media (prefers-color-scheme: dark) {
          :root {
            --bg: oklch(0.1 0.005 270);
            --surface-1: oklch(0.13 0.006 270);
            --surface-2: oklch(0.155 0.008 270);
            --border: oklch(0.23 0.005 270);
            --border-subtle: oklch(0.2 0.004 270);
            --text-primary: oklch(0.95 0 0);
            --text-muted: oklch(0.55 0 0);
            --primary: oklch(0.62 0.22 260);
            --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.25);
            --shadow-elevated: 0 8px 24px rgba(0, 0, 0, 0.4);
          }
        }

        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          background: var(--bg);
          color: var(--text-primary);
          font-family: "Noto Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          transition: background 150ms ease, color 150ms ease;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }

        #oauth-container {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          padding: 20px;
        }

        /* Premium glass card — native macOS feel */
        .auth-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          padding: 32px 40px;
          background: var(--surface-2);
          border: 1px solid var(--border);
          border-radius: 8px;
          box-shadow: var(--shadow-elevated);
          animation: fade-in 300ms ease-out;
        }

        @media (prefers-color-scheme: dark) {
          .auth-card {
            background: var(--surface-2);
            border: 1px solid var(--border);
            box-shadow: var(--shadow-elevated), 0 0 0 1px rgba(255, 255, 255, 0.03);
          }
        }

        /* Logo container with refined drop shadow */
        .logo-wrapper {
          position: relative;
          margin-bottom: 4px;
        }

        .logo {
          display: block;
          filter: drop-shadow(0 2px 8px rgba(37, 99, 235, 0.18));
        }

        @media (prefers-color-scheme: dark) {
          .logo {
            filter: drop-shadow(0 2px 12px rgba(100, 149, 237, 0.25));
          }
        }

        /* Premium spinner with metallic feel */
        .spinner-wrapper {
          position: relative;
          width: 28px;
          height: 28px;
        }

        .spinner {
          width: 28px;
          height: 28px;
          border: 2.5px solid transparent;
          border-top-color: var(--primary);
          border-radius: 50%;
          animation: spinner-rotate 0.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }

        /* Tight, minimal text hierarchy */
        .content {
          text-align: center;
          line-height: 1.4;
        }

        h1 {
          font-size: 15px;
          font-weight: 600;
          letter-spacing: -0.01em;
          color: var(--text-primary);
          margin-bottom: 2px;
        }

        .subtitle {
          font-size: 13px;
          font-weight: 500;
          color: var(--text-muted);
          opacity: 0.8;
        }

        /* Smooth animations */
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(4px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        @keyframes spinner-rotate {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        /* Accessibility — respect reduced motion */
        @media (prefers-reduced-motion: reduce) {
          .auth-card {
            animation: fade-in-simple 200ms ease-out;
          }
          @keyframes fade-in-simple {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          .spinner {
            animation: none;
            border-top-color: var(--text-muted);
            opacity: 0.5;
          }
        }
      </style>

      <div id="oauth-container" role="status" aria-live="polite">
        <div class="auth-card">
          <div class="logo-wrapper">
            <svg class="logo" viewBox="0 0 1024 1024" width="64" height="64" aria-label="OpenWhispr">
              <rect width="1024" height="1024" rx="241" fill="#2056DF"/>
              <circle cx="512" cy="512" r="314" fill="#2056DF" stroke="white" stroke-width="74"/>
              <path d="M512 383V641" stroke="white" stroke-width="74" stroke-linecap="round"/>
              <path d="M627 457V568" stroke="white" stroke-width="74" stroke-linecap="round"/>
              <path d="M397 457V568" stroke="white" stroke-width="74" stroke-linecap="round"/>
            </svg>
          </div>

          <div class="spinner-wrapper">
            <div class="spinner"></div>
          </div>

          <div class="content">
            <h1>${redirectTitle}</h1>
            <p class="subtitle">${closeTab}</p>
          </div>
        </div>
      </div>
    `;
    return true;
  }
  return false;
}

if (!isOAuthBrowserRedirect()) {
  mountApp();
}

function mountApp() {
  if (!root) {
    root = ReactDOM.createRoot(document.getElementById("root"));
  }
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <I18nextProvider i18n={i18n}>
          <SettingsProvider>
            <ToastProvider>
              <AppRouter />
            </ToastProvider>
          </SettingsProvider>
        </I18nextProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
}

if (import.meta.hot) {
  import.meta.hot.accept();
}

import React from "react";
import i18n from "../i18n";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-surface-primary flex items-center justify-center p-6">
          <div className="max-w-md text-center space-y-4">
            <h1 className="text-lg font-semibold text-primary">{i18n.t("errorBoundary.title")}</h1>
            <p className="text-sm text-secondary">{i18n.t("errorBoundary.description")}</p>
            {this.state.error && (
              <pre
                dir="ltr"
                className="text-xs text-red-solid bg-surface-secondary rounded-md p-3 overflow-auto max-h-32 text-left"
              >
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={this.handleReload}
              className="inline-flex items-center justify-center rounded-md bg-brand-solid px-4 py-2 text-sm font-medium text-on-solid hover:bg-brand-solid/90 transition-colors"
            >
              {i18n.t("errorBoundary.reload")}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

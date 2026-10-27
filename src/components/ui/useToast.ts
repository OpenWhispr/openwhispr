import * as React from "react";

export type ToastPresentation = "standard" | "dictation-error";

export interface TechnicalErrorDetailsData {
  provider?: string;
  status?: number;
  exceptionType?: string;
  requestId?: string;
  underlyingError?: string;
}

export interface ToastActionConfig {
  label: string;
  icon?: "retry" | "transcript" | "settings" | "copy";
  onClick: () => void | boolean | Promise<void | boolean>;
  feedback?: { successLabel: string; failureLabel: string };
  dismissOnClick?: boolean;
  /** Shown as its icon alone, after the labelled actions; the label becomes its accessible name. */
  iconOnly?: boolean;
}

export interface ToastProps {
  id?: string;
  title?: string;
  description?: string;
  descriptionHotkey?: string;
  secondaryDescription?: string;
  copyCommand?: string;
  technicalDetails?: TechnicalErrorDetailsData;
  action?: React.ReactNode;
  actions?: ToastActionConfig[];
  /** Which side of a standard toast its `actions` row sits on; start by default. */
  actionsAlign?: "start" | "end";
  presentation?: ToastPresentation;
  variant?: "default" | "destructive" | "success";
  duration?: number;
  onClose?: () => void;
  dismissible?: boolean;
}

export interface ToastContextType {
  toast: (props: Omit<ToastProps, "id">) => string;
  dismiss: (id?: string) => void;
  toastCount: number;
  dictationErrorActionCount: number;
  dismissByPresentation: (presentation: ToastPresentation) => void;
}

export const ToastContext = React.createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
};

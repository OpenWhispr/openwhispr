import * as React from "react";

export type ToastPresentation = "standard" | "dictation-error";

export interface TechnicalErrorDetailsData {
  status?: number;
  exceptionType?: string;
  requestId?: string;
  underlyingError?: string;
}

export interface ToastActionConfig {
  label: string;
  icon?: "retry" | "transcript";
  onClick: () => void | Promise<void>;
  dismissOnClick?: boolean;
}

export interface ToastProps {
  id?: string;
  title?: string;
  description?: string;
  secondaryDescription?: string;
  copyCommand?: string;
  technicalDetails?: TechnicalErrorDetailsData;
  action?: React.ReactNode;
  actions?: ToastActionConfig[];
  presentation?: ToastPresentation;
  variant?: "default" | "destructive" | "success";
  duration?: number;
  onClose?: () => void;
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

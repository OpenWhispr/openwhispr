import * as React from "react";

export type ToastCategory = "transcription" | "downloads" | "clipboard";

export interface ToastProps {
  id?: string;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  variant?: "default" | "destructive" | "success";
  category?: ToastCategory;
  duration?: number;
  onClose?: () => void;
}

export interface ToastContextType {
  toast: (props: Omit<ToastProps, "id">) => void;
  dismiss: (id?: string) => void;
  toastCount: number;
}

export const ToastContext = React.createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
};

import React from "react";
import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "./lib/utils";
import { ReferralDashboard } from "./ReferralDashboard";

interface ReferralModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ReferralModal({ open, onOpenChange }: ReferralModalProps) {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/60 backdrop-blur-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-50 w-full max-w-[500px] min-h-[520px]",
            "translate-x-[-50%] translate-y-[-50%]",
            "rounded-xl border overflow-hidden shadow-2xl duration-200",
            "bg-card border-border",
            "shadow-[0_24px_48px_-12px_oklch(0_0_0/0.12)] dark:shadow-[0_24px_48px_-12px_oklch(0_0_0/0.5)]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]",
            "data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("referral.modalTitle")}
          </DialogPrimitive.Title>

          <DialogPrimitive.Close className="absolute right-3 top-3 z-20 rounded-full p-1.5 opacity-40 transition-[opacity,background-color] hover:opacity-80 hover:bg-foreground/10 focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:ring-offset-0">
            <X className="h-4 w-4 text-foreground" />
            <span className="sr-only">{t("common.close")}</span>
          </DialogPrimitive.Close>

          <ReferralDashboard />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

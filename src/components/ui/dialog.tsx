import * as React from "react";
import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { blurBehindOverlays } from "./overlayBlur";
import { useDismissGuard } from "./useDismissGuard";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      blurBehindOverlays && "backdrop-blur-lg",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { overlayClassName?: string }
>(
  (
    {
      className,
      children,
      onInteractOutside,
      onOpenAutoFocus,
      onCloseAutoFocus,
      overlayClassName,
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation();
    const { registerContent, shouldBlockDismiss } =
      useDismissGuard<React.ElementRef<typeof DialogPrimitive.Content>>();
    const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null);
    // Radix Presence keeps its composed ref stable across caller-ref changes.
    // Forward the committed DOM node before paint, with the caller's cleanup,
    // so replacing a resource ref really replaces its lease while still open.
    React.useLayoutEffect(() => {
      if (!contentNode) return;
      const cleanup =
        typeof ref === "function"
          ? (ref as React.RefCallback<HTMLDivElement>)(contentNode)
          : undefined;
      if (ref && typeof ref !== "function") ref.current = contentNode;
      return () => {
        if (typeof cleanup === "function") cleanup();
        else if (typeof ref === "function") ref(null);
        else if (ref) ref.current = null;
      };
    }, [contentNode, ref]);
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const lastContentRef = React.useRef<HTMLDivElement | null>(null);
    const invokerRef = React.useRef<HTMLElement | null>(null);
    const parentDialogRef = React.useRef<HTMLElement | null>(null);
    const captureInvoker = () => {
      const active = document.activeElement;
      if (
        !(active instanceof HTMLElement) ||
        active === document.body ||
        contentRef.current?.contains(active)
      )
        return;
      invokerRef.current = active;
      parentDialogRef.current = active.closest<HTMLElement>('[role="dialog"]');
    };
    // Portal mounts its children after this commit. Capture before an input's
    // autoFocus or Radix's FocusScope can replace the opening control.
    React.useLayoutEffect(() => {
      if (!contentRef.current) captureInvoker();
    });
    const attachContent = React.useCallback(
      (node: HTMLDivElement | null) => {
        contentRef.current = node;
        setContentNode(node);
        if (node) lastContentRef.current = node;
        const cleanup = registerContent(node);
        if (!node) return;
        return () => {
          contentRef.current = null;
          setContentNode(null);
          cleanup?.();
        };
      },
      [registerContent]
    );

    return (
      <DialogPortal>
        <DialogOverlay className={overlayClassName} />
        <DialogPrimitive.Content
          ref={attachContent}
          onOpenAutoFocus={(event) => {
            captureInvoker();
            onOpenAutoFocus?.(event);
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            event.preventDefault();
            const active = document.activeElement;
            if (
              active &&
              active !== document.body &&
              active.isConnected &&
              !lastContentRef.current?.contains(active)
            )
              return;
            const survives = (node: HTMLElement | null) =>
              node?.isConnected &&
              !node.closest('[hidden], [inert], [data-state="closed"]') &&
              !node.matches(":disabled");
            const target = survives(invokerRef.current)
              ? invokerRef.current
              : survives(parentDialogRef.current)
                ? parentDialogRef.current
                : null;
            target?.focus({ preventScroll: true });
          }}
          onInteractOutside={(event) => {
            onInteractOutside?.(event);
            if (event.defaultPrevented) return;
            if (shouldBlockDismiss(event)) event.preventDefault();
          }}
          className={cn(
            "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border p-6 shadow-2xl duration-200 rounded-2xl",
            "bg-card border-border/70",
            "dark:bg-surface-2 dark:border-border dark:shadow-modal",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
            className
          )}
          {...props}
        >
          {children}
          <DialogPrimitive.Close className="absolute end-4 top-4 rounded-full opacity-50 ring-offset-background transition-[opacity,background-color] hover:opacity-100 hover:bg-muted/50 dark:hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none p-1.5">
            <X className="h-4 w-4 text-muted-foreground" />
            <span className="sr-only">{t("common.close")}</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  }
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col space-y-1.5 text-center sm:text-start", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:gap-2", className)}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight text-foreground brand-heading",
      className
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground brand-body", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

// Custom confirmation dialog component
interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  variant?: "default" | "destructive";
  /** Extra content between the header and the footer (e.g. a type-to-confirm input). */
  children?: React.ReactNode;
  confirmDisabled?: boolean;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  variant = "default",
  children,
  confirmDisabled = false,
}) => {
  const { t } = useTranslation();
  const confirmRef = React.useRef<HTMLButtonElement>(null);

  const handleConfirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  // Radix auto-focuses the first tabbable — the Cancel button — so Enter used
  // to cancel. Focus Confirm instead, except: destructive dialogs keep Cancel
  // focused (Enter must never destroy by default), and dialogs with children
  // keep Radix's choice (a type-to-confirm input owns focus and Enter itself).
  const handleOpenAutoFocus = (event: Event) => {
    if (children != null || variant === "destructive") return;
    event.preventDefault();
    confirmRef.current?.focus();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]" onOpenAutoFocus={handleOpenAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {cancelText ?? t("common.cancel")}
          </Button>
          <Button
            ref={confirmRef}
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={confirmDisabled}
          >
            {confirmText ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// Custom alert dialog component
interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  okText?: string;
  onOk: () => void;
}

const AlertDialog: React.FC<AlertDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  okText,
  onOk,
}) => {
  const handleOk = () => {
    onOk();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="default" onClick={handleOk}>
            {okText ?? "OK"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  ConfirmDialog,
  AlertDialog,
};

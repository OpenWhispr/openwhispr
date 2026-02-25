import React from "react";
import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export interface SidebarItem<T extends string> {
  id: T;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group?: string;
  description?: string;
  badge?: string;
  badgeVariant?: "default" | "new" | "update" | "dot";
  shortcut?: string;
}

interface SidebarModalProps<T extends string> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  sidebarItems: SidebarItem<T>[];
  activeSection: T;
  onSectionChange: (section: T) => void;
  children: React.ReactNode;
  sidebarWidth?: string;
  version?: string;
}

export default function SidebarModal<T extends string>({
  open,
  onOpenChange,
  title,
  sidebarItems,
  activeSection,
  onSectionChange,
  children,
  sidebarWidth = "w-52",
  version,
}: SidebarModalProps<T>) {
  const { t } = useTranslation();
  // Group items by their group property
  const groupedItems = React.useMemo(() => {
    const groups: { label: string | null; items: SidebarItem<T>[] }[] = [];
    let currentGroup: string | null | undefined = undefined;

    for (const item of sidebarItems) {
      const group = item.group ?? null;
      if (group !== currentGroup) {
        groups.push({ label: group, items: [item] });
        currentGroup = group;
      } else {
        groups[groups.length - 1].items.push(item);
      }
    }

    return groups;
  }, [sidebarItems]);

  const renderBadge = (item: SidebarItem<T>) => {
    if (!item.badge && item.badgeVariant !== "dot") return null;

    if (item.badgeVariant === "dot") {
      return <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary shrink-0" />;
    }

    return (
      <span
        className={`ml-auto text-xs font-semibold uppercase tracking-wider px-1.5 py-px rounded-sm shrink-0 ${
          item.badgeVariant === "new"
            ? "bg-primary/10 text-primary dark:bg-primary/15"
            : item.badgeVariant === "update"
              ? "bg-warning/10 text-warning dark:bg-warning/15"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {item.badge}
      </span>
    );
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed left-[50%] top-[50%] z-50 max-h-[85vh] w-[90vw] max-w-4xl translate-x-[-50%] translate-y-[-50%] rounded-xl p-0 overflow-hidden bg-background border border-border shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:bg-surface-1 dark:border-border-subtle dark:shadow-[0_25px_60px_-12px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.05)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-98 data-[state=open]:zoom-in-98">
          <div className="relative h-full max-h-[85vh] overflow-hidden">
            <DialogPrimitive.Close className="absolute right-4 top-4 z-10 rounded-md p-1.5 opacity-40 ring-offset-background transition-[opacity,background-color] hover:opacity-100 bg-transparent hover:bg-muted dark:hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1">
              <X className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="sr-only">{t("common.close")}</span>
            </DialogPrimitive.Close>

            <div className="flex h-[85vh]">
              {/* Sidebar */}
              <div
                className={`${sidebarWidth} shrink-0 border-r border-border/40 dark:border-border-subtle flex flex-col bg-surface-1 dark:bg-surface-0`}
              >
                {/* Title */}
                <div className="px-4 pt-5 pb-0.5">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70">
                    {title}
                  </h2>
                </div>

                {/* Navigation */}
                <nav className="relative flex-1 px-2 pt-2.5 pb-2 overflow-y-auto">
                  {groupedItems.map((group, groupIndex) => (
                    <div key={groupIndex} className={groupIndex > 0 ? "mt-3" : ""}>
                      {group.label && (
                        <div className="px-2 pb-0.5 pt-1.5">
                          <span className="text-xs font-medium tracking-[0.08em] uppercase text-muted-foreground/60 dark:text-muted-foreground/65">
                            {group.label}
                          </span>
                        </div>
                      )}
                      <div className="space-y-px">
                        {group.items.map((item) => {
                          const Icon = item.icon;
                          const isActive = activeSection === item.id;
                          return (
                            <button
                              key={item.id}
                              data-section-id={item.id}
                              onClick={() => onSectionChange(item.id)}
                              className={`group relative w-full flex items-center gap-2.5 px-2.5 py-2 text-left text-xs rounded-lg transition-colors duration-100 outline-none ${
                                isActive
                                  ? "text-foreground bg-muted dark:bg-surface-raised"
                                  : "text-muted-foreground dark:text-foreground/75 hover:text-foreground hover:bg-muted/50 dark:hover:bg-surface-2"
                              }`}
                            >
                              {/* Active indicator bar */}
                              {isActive && (
                                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-primary" />
                              )}
                              <div
                                className={`flex items-center justify-center h-6 w-6 rounded-md shrink-0 transition-colors duration-100 ${
                                  isActive ? "bg-primary/10 dark:bg-primary/15" : "bg-transparent"
                                }`}
                              >
                                <Icon
                                  className={`h-4 w-4 shrink-0 transition-colors duration-100 ${
                                    isActive
                                      ? "text-primary"
                                      : "text-muted-foreground/70 dark:text-foreground/55 group-hover:text-foreground/80"
                                  }`}
                                />
                              </div>
                              <span
                                className={`flex-1 truncate leading-tight ${isActive ? "font-medium" : "font-normal"}`}
                              >
                                {item.label}
                              </span>
                              {renderBadge(item)}
                              {item.shortcut && !item.badge && (
                                <kbd className="ml-auto text-xs text-muted-foreground/25 font-mono shrink-0">
                                  {item.shortcut}
                                </kbd>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </nav>

                {/* Footer / version */}
                {version && (
                  <div className="px-3 py-2.5 border-t border-border/20 dark:border-border-subtle">
                    <div className="flex items-center gap-1.5">
                      <div className="h-1 w-1 rounded-full bg-success/60" />
                      <span className="text-xs text-muted-foreground/40 tabular-nums tracking-wide">
                        v{version}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Main Content */}
              <div className="flex-1 overflow-y-auto bg-background dark:bg-surface-1">
                <div className="p-6">{children}</div>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

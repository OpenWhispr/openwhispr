import { Fragment, type ReactElement } from "react";
import { ChevronRight } from "../icons";
import { cn } from "../lib/utils";

interface BreadcrumbItem {
  label: string;
  onSelect?: () => void;
}

interface BreadcrumbProps {
  /** Names the trail for screen readers. */
  label: string;
  /** From the top level down; the last item is the page that's open. */
  items: BreadcrumbItem[];
}

/** "Parent › Current", where each parent is a quiet link back. */
export function Breadcrumb({ label, items }: BreadcrumbProps): ReactElement {
  return (
    <nav aria-label={label} className="mb-2">
      <ol className="flex items-center gap-1 text-xs leading-none">
        {items.map((item, index) => (
          <Fragment key={item.label}>
            {index > 0 && (
              <li aria-hidden="true" className="text-muted-foreground/50">
                <ChevronRight className="h-3 w-3 rtl:rotate-180" />
              </li>
            )}
            <li>
              {index === items.length - 1 ? (
                <span aria-current="page" className="px-1 py-0.5 font-medium text-foreground">
                  {item.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={item.onSelect}
                  className={cn(
                    "rounded-sm px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
                    index === 0 && "-ms-1"
                  )}
                >
                  {item.label}
                </button>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

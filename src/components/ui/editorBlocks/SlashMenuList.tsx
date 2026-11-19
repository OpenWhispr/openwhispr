/** The list shown by the "/" command menu. */
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { tb } from "./translate";
import type { SlashItem } from "./SlashMenu";

export interface ListProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}
export interface ListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const SlashMenuList = forwardRef<ListHandle, ListProps>(function SlashMenuList(
  { items, command },
  ref
) {
  useTranslation(); // re-render on UI language change
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);
  useEffect(() => {
    document
      .querySelector(`[data-rte-slash-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event) => {
        if (!items.length) return false;
        if (event.key === "ArrowDown") return (setSelected((i) => (i + 1) % items.length), true);
        if (event.key === "ArrowUp")
          return (setSelected((i) => (i - 1 + items.length) % items.length), true);
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }),
    [items, selected, command]
  );
  if (!items.length) return null;
  let lastGroup = "";
  return (
    <div className="rte-slash-menu w-72 max-h-80 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
      {items.map((item, index) => {
        const header = item.group !== lastGroup ? tb(`groups.${item.group}`) : null;
        lastGroup = item.group;
        return (
          <div key={item.id}>
            {header && (
              <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {header}
              </div>
            )}
            <button
              type="button"
              data-rte-slash-index={index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => command(item)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm",
                index === selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
              )}
            >
              <span className="truncate">{item.title()}</span>
              {item.hint && (
                <span className="shrink-0 text-xs text-muted-foreground">{item.hint()}</span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
});

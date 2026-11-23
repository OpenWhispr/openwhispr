/** The [[ note picker shown while typing a note link. */
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { tb } from "./translate";

export interface LinkItem {
  title: string;
  id: number | null; // null = link to a title with no note (yet)
}

export interface PickerProps {
  items: LinkItem[];
  command: (item: LinkItem) => void;
}
export interface PickerHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const NoteLinkPicker = forwardRef<PickerHandle, PickerProps>(function NoteLinkPicker(
  { items, command },
  ref
) {
  useTranslation(); // re-render on UI language change
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);
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
  return (
    <div className="w-72 rounded-md border border-border bg-popover p-1 shadow-lg">
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {tb("link.header")}
      </div>
      {!items.length && (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">{tb("link.empty")}</div>
      )}
      {items.map((item, index) => (
        <button
          key={`${item.id ?? "new"}-${item.title}`}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => command(item)}
          className={cn(
            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
            index === selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
          )}
        >
          <span aria-hidden="true" className="text-muted-foreground">
            {item.id ? "📄" : "＋"}
          </span>
          <span className="truncate">
            {item.id ? item.title : tb("link.create", { title: item.title })}
          </span>
        </button>
      ))}
    </div>
  );
});

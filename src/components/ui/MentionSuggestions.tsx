import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import PersonAvatar from "./PersonAvatar";
import { cn } from "../lib/utils";

/** Conforms to MentionNodeAttrs so it can flow through the suggestion plugin. */
export interface MentionSuggestionItem extends MentionNodeAttrs {
  label: string;
  email: string | null;
}

export interface MentionSuggestionsProps {
  items: MentionSuggestionItem[];
  command: (item: MentionSuggestionItem) => void;
}

export interface MentionSuggestionsHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/** Keyboard-navigable @mention picker rendered next to the editor caret. */
const MentionSuggestions = forwardRef<MentionSuggestionsHandle, MentionSuggestionsProps>(
  function MentionSuggestions({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => setSelectedIndex(0), [items]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event) => {
          if (items.length === 0) return false;
          if (event.key === "ArrowDown") {
            setSelectedIndex((i) => (i + 1) % items.length);
            return true;
          }
          if (event.key === "ArrowUp") {
            setSelectedIndex((i) => (i - 1 + items.length) % items.length);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const item = items[selectedIndex];
            if (item) command(item);
            return true;
          }
          return false;
        },
      }),
      [items, selectedIndex, command]
    );

    if (items.length === 0) return null;

    return (
      <div className="w-60 rounded-md border border-border bg-popover p-1 shadow-lg">
        {items.map((item, index) => (
          <button
            key={`${item.label}-${item.email ?? index}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(item)}
            onMouseEnter={() => setSelectedIndex(index)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/70 transition-colors cursor-pointer",
              index === selectedIndex && "bg-foreground/5 text-foreground"
            )}
          >
            <PersonAvatar email={item.email} displayName={item.label} size={20} />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.email && (
              <span className="truncate text-[11px] text-foreground/30">{item.email}</span>
            )}
          </button>
        ))}
      </div>
    );
  }
);

export default MentionSuggestions;

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, MessageSquare, NotebookPen, Plus } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  SPLIT_BUTTON_DIVIDER_CLASS,
  SPLIT_BUTTON_GROUP_CLASS,
  SPLIT_BUTTON_SEGMENT_CLASS,
} from "../ui/splitButton";
import { cn } from "../lib/utils";

// Matched to the search bar it sits beside: the same translucent fill that
// lifts on hover, under the same hairline. The note's Share control keeps its
// own pill, so these apply to this instance of the shared split button rather
// than to the definition both share.
const SOFT_GROUP_CLASS = "bg-foreground/4 dark:bg-white/5";
const SOFT_SEGMENT_CLASS =
  "hover:bg-foreground/6 focus-visible:bg-foreground/6 focus-visible:ring-1 focus-visible:ring-primary/30 dark:hover:bg-white/8 dark:focus-visible:bg-white/8";
const SOFT_DIVIDER_CLASS = "bg-foreground/8";

interface NewNoteMenuProps {
  onNewNote: () => void;
  /** Opens a new chat in the Chat tab; omitted when policy turns the assistant off. */
  onNewChat?: () => void;
}

/** The topbar's split "New note" button; the chevron offers the other things to create. */
export default function NewNoteMenu({ onNewNote, onNewChat }: NewNoteMenuProps) {
  const { t } = useTranslation();
  const itemChosenRef = useRef(false);

  // The chat input takes focus itself, so selecting chat keeps it. A new note
  // focuses nothing (the editor mounts fresh), and dismissing the menu returns
  // focus to the chevron, as Radix does by default.
  const keepFocus = (action: () => void) => () => {
    itemChosenRef.current = true;
    action();
  };

  return (
    <div className={cn(SPLIT_BUTTON_GROUP_CLASS, SOFT_GROUP_CLASS, "h-8")}>
      <button
        type="button"
        onClick={onNewNote}
        className={cn(
          SPLIT_BUTTON_SEGMENT_CLASS,
          SOFT_SEGMENT_CLASS,
          "gap-1.5 whitespace-nowrap ps-3 pe-3.5"
        )}
      >
        <Plus size={14} />
        {t("notes.list.newNote")}
      </button>
      <span aria-hidden="true" className={cn(SPLIT_BUTTON_DIVIDER_CLASS, SOFT_DIVIDER_CLASS)} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("notes.createMenu.chooseType")}
            className={cn(SPLIT_BUTTON_SEGMENT_CLASS, SOFT_SEGMENT_CLASS, "w-8 justify-center")}
          >
            <ChevronDown size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-44"
          onCloseAutoFocus={(event) => {
            if (!itemChosenRef.current) return;
            itemChosenRef.current = false;
            event.preventDefault();
          }}
        >
          <DropdownMenuItem onSelect={onNewNote} className="gap-2.5">
            <NotebookPen className="h-4 w-4" />
            {t("notes.createMenu.note")}
          </DropdownMenuItem>
          {onNewChat && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={keepFocus(onNewChat)} className="gap-2.5">
                <MessageSquare className="h-4 w-4" />
                {t("notes.createMenu.assistantChat")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

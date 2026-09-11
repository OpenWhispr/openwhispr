import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, MessageSquare, NotebookPen, Plus, Users } from "../icons";
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
import { useCanCreateTeamSpace } from "../../hooks/useCanCreateTeamSpace";
import CreateSpaceDialog from "./CreateSpaceDialog";

interface NewNoteMenuProps {
  onNewNote: () => void;
  /** Opens a fresh assistant chat in Notes: the open note's, or the overview's. */
  onNewChat: () => void;
}

/** The Notes topbar's split "New note" button; the chevron offers the other things to create. */
export default function NewNoteMenu({ onNewNote, onNewChat }: NewNoteMenuProps) {
  const { t } = useTranslation();
  const canCreateTeamSpace = useCanCreateTeamSpace();
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const itemChosenRef = useRef(false);

  // Each item hands focus to what it opens (the chat input, the space dialog), so only
  // those closes keep it; dismissing the menu still returns focus to the chevron.
  const chooseItem = (action: () => void) => () => {
    itemChosenRef.current = true;
    action();
  };

  return (
    <>
      <div className={cn(SPLIT_BUTTON_GROUP_CLASS, "h-8")}>
        <button
          type="button"
          onClick={onNewNote}
          className={cn(SPLIT_BUTTON_SEGMENT_CLASS, "gap-1.5 whitespace-nowrap ps-3 pe-3.5")}
        >
          <Plus size={14} />
          {t("notes.list.newNote")}
        </button>
        <span aria-hidden="true" className={SPLIT_BUTTON_DIVIDER_CLASS} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("notes.createMenu.chooseType")}
              className={cn(SPLIT_BUTTON_SEGMENT_CLASS, "w-8 justify-center")}
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
            <DropdownMenuItem onSelect={chooseItem(onNewNote)} className="gap-2.5">
              <NotebookPen className="h-4 w-4" />
              {t("notes.createMenu.note")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={chooseItem(onNewChat)} className="gap-2.5">
              <MessageSquare className="h-4 w-4" />
              {t("notes.createMenu.assistantChat")}
            </DropdownMenuItem>
            {canCreateTeamSpace && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={chooseItem(() => setCreateSpaceOpen(true))}
                  className="gap-2.5"
                >
                  <Users className="h-4 w-4" />
                  {t("notes.createMenu.teamSpace")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CreateSpaceDialog open={createSpaceOpen} onOpenChange={setCreateSpaceOpen} />
    </>
  );
}

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
  /** Opens a new chat in the Chat tab; omitted when policy turns the assistant off. */
  onNewChat?: () => void;
}

/** The Notes topbar's split "New note" button; the chevron offers the other things to create. */
export default function NewNoteMenu({ onNewNote, onNewChat }: NewNoteMenuProps) {
  const { t } = useTranslation();
  const canCreateTeamSpace = useCanCreateTeamSpace();
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const itemChosenRef = useRef(false);

  // The chat input and the space dialog take focus themselves, so those closes
  // keep it. A new note focuses nothing (the editor mounts fresh), and dismissing
  // the menu returns focus to the chevron, as Radix does by default.
  const keepFocus = (action: () => void) => () => {
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
            {canCreateTeamSpace && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={keepFocus(() => setCreateSpaceOpen(true))}
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

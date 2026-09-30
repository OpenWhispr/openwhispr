import { useCallback } from "react";
import { findParentNode, type Editor } from "@tiptap/core";
import { isInTable, selectedRect } from "@tiptap/pm/tables";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import {
  editorHasFocus,
  refocusEditor,
  runCommand,
  useHideOnFocusLeave,
  useMenuDropdown,
  type ChainCommand,
} from "./RichTextEditorMenus";

const findTable = findParentNode((node) => node.type.name === "table");

function getTableElement(editor: Editor): HTMLTableElement | null {
  const table = findTable(editor.state.selection);
  // Tiptap's TableView renders every table inside a wrapper div.
  return table ? (editor.view.nodeDOM(table.pos) as HTMLElement).querySelector("table") : null;
}

// Beside the header row, or above the table when there is no room beside it.
// Shifting on both axes keeps it inside the scroller when a wide table starts the
// note. BubbleMenu applies `offset` after `shift`, which would push it back out,
// so the gap is padding on the menu instead (pl-1.5 pb-1.5 below).
const MENU_OPTIONS: BubbleMenuProps["options"] = {
  placement: "right-start",
  offset: false,
  flip: { fallbackPlacements: ["top-end"] },
  shift: { crossAxis: true },
};

const PLUGIN_KEY = "tableMenu";
const PLUGIN_KEYS = [PLUGIN_KEY];

const shouldShowMenu: BubbleMenuProps["shouldShow"] = ({ editor, view }) =>
  editor.isEditable && editor.isActive("table") && editorHasFocus(view);

/**
 * Rendered only while the menu is open, from the current selection. The note can
 * re-render it after Delete table, when the caret has already left the table, and
 * a read-only editor offers no actions.
 */
function TableActions({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  if (!editor.isEditable || !isInTable(editor.state)) return null;
  const rect = selectedRect(editor.state);

  const run = (command: ChainCommand) => runCommand(editor, command);

  // Tables follow the note's text direction, so "left" is the next column in RTL.
  const addColumn = (side: "left" | "right") => {
    const table = getTableElement(editor);
    const rtl = !!table && getComputedStyle(table).direction === "rtl";
    run((chain) => ((side === "left") !== rtl ? chain.addColumnBefore() : chain.addColumnAfter()));
  };

  const item = (
    label: string,
    onSelect: () => void,
    { disabled = false, destructive = false } = {}
  ) => (
    <DropdownMenuItem
      className={cn(
        "text-xs rounded-md px-2 py-1.5",
        destructive && "text-destructive focus:bg-destructive/10 focus:text-destructive"
      )}
      disabled={disabled}
      onSelect={onSelect}
    >
      {label}
    </DropdownMenuItem>
  );

  return (
    <>
      {item(
        t("notes.editor.table.insertRowAbove"),
        () => run((chain) => chain.addRowBefore()),
        // A row above the header would take over as the header.
        { disabled: rect.top === 0 }
      )}
      {item(t("notes.editor.table.insertRowBelow"), () => run((chain) => chain.addRowAfter()))}
      {item(t("notes.editor.table.insertColumnLeft"), () => addColumn("left"))}
      {item(t("notes.editor.table.insertColumnRight"), () => addColumn("right"))}
      <DropdownMenuSeparator />
      {/* prosemirror-tables won't delete every row or column; Delete table does that. */}
      {item(t("notes.editor.table.deleteRow"), () => run((chain) => chain.deleteRow()), {
        disabled: rect.top === 0 && rect.bottom === rect.map.height,
      })}
      {item(t("notes.editor.table.deleteColumn"), () => run((chain) => chain.deleteColumn()), {
        disabled: rect.left === 0 && rect.right === rect.map.width,
      })}
      {item(t("notes.editor.table.deleteTable"), () => run((chain) => chain.deleteTable()), {
        destructive: true,
      })}
    </>
  );
}

/** Row and column actions for the table holding the caret. */
export function RichTextEditorTableMenu({ editor }: { editor: Editor }) {
  const { t } = useTranslation();
  const { menuRef, container, open, setOpen, options } = useMenuDropdown(MENU_OPTIONS);
  useHideOnFocusLeave(editor, PLUGIN_KEYS);

  // Stable, like the options above: BubbleMenu dispatches a transaction whenever these change.
  const getReferencedVirtualElement = useCallback(() => {
    const table = getTableElement(editor);
    return table && { getBoundingClientRect: () => table.getBoundingClientRect() };
  }, [editor]);

  return (
    <BubbleMenu
      ref={menuRef}
      editor={editor}
      pluginKey={PLUGIN_KEY}
      shouldShow={shouldShowMenu}
      getReferencedVirtualElement={getReferencedVirtualElement}
      options={options}
      className="pl-1.5 pb-1.5"
    >
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("notes.editor.table.actions")}
            className="h-6 w-6 rounded-md border border-border bg-popover text-muted-foreground shadow-sm hover:text-foreground hover:bg-foreground/5"
          >
            <MoreHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          container={container}
          align="end"
          className="min-w-44 p-1"
          onCloseAutoFocus={refocusEditor(editor)}
        >
          <TableActions editor={editor} />
        </DropdownMenuContent>
      </DropdownMenu>
    </BubbleMenu>
  );
}

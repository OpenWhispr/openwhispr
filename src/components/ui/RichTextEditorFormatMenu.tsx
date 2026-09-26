import type { ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection, type EditorState } from "@tiptap/pm/state";
import { isInTable } from "@tiptap/pm/tables";
import { useEditorState } from "@tiptap/react";
import {
  BubbleMenu,
  FloatingMenu,
  type BubbleMenuProps,
  type FloatingMenuProps,
} from "@tiptap/react/menus";
import { useTranslation } from "react-i18next";
import {
  Bold,
  Check,
  ChevronDown,
  Code2,
  Heading,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Strikethrough,
  Table,
  type IconComponent,
} from "../icons";
import { cn } from "../lib/utils";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { insertEmptyTable, isOnEmptyLine } from "./RichTextEditorTable";

interface FormatAction {
  key: string;
  icon: IconComponent;
  shortcut: string;
  run: ChainCommand;
}

const MARKS: FormatAction[] = [
  { key: "bold", icon: Bold, shortcut: "CommandOrControl+B", run: (c) => c.toggleBold() },
  { key: "italic", icon: Italic, shortcut: "CommandOrControl+I", run: (c) => c.toggleItalic() },
  {
    key: "strike",
    icon: Strikethrough,
    shortcut: "CommandOrControl+Shift+S",
    run: (c) => c.toggleStrike(),
  },
  { key: "code", icon: Code2, shortcut: "CommandOrControl+E", run: (c) => c.toggleCode() },
];

const BLOCKS: FormatAction[] = [
  {
    key: "bulletList",
    icon: List,
    shortcut: "CommandOrControl+Shift+8",
    run: (c) => c.toggleBulletList(),
  },
  {
    key: "orderedList",
    icon: ListOrdered,
    shortcut: "CommandOrControl+Shift+7",
    run: (c) => c.toggleOrderedList(),
  },
  {
    key: "taskList",
    icon: ListChecks,
    shortcut: "CommandOrControl+Shift+9",
    run: (c) => c.toggleTaskList(),
  },
  {
    key: "blockquote",
    icon: Quote,
    shortcut: "CommandOrControl+Shift+B",
    run: (c) => c.toggleBlockquote(),
  },
];

const HEADING_LEVELS = [1, 2, 3] as const;

const TEXT_STYLES: { key: string; level: number; run: ChainCommand }[] = [
  { key: "paragraph", level: 0, run: (c) => c.setParagraph() },
  ...HEADING_LEVELS.map((level) => ({
    key: `heading${level}`,
    level,
    run: (c) => c.setHeading({ level }),
  })),
];

const SELECTION_MENU = "formatSelectionMenu";
const LINE_MENU = "formatLineMenu";
const MENU_KEYS = [SELECTION_MENU, LINE_MENU];

// Tables have their own menu, and none of these actions belong in a code block:
// the marks don't apply there and a list would take the fence apart.
const canFormat = (editor: Editor, state: EditorState): boolean =>
  !editor.isDestroyed &&
  editor.isEditable &&
  editorHasFocus(editor.view) &&
  !isInTable(state) &&
  !editor.isActive("codeBlock");

// Above selected text.
const shouldShowOnSelection: BubbleMenuProps["shouldShow"] = ({ editor, state }) =>
  canFormat(editor, state) && !state.selection.empty && !(state.selection instanceof NodeSelection);

// On an empty top-level line, where a list, heading or table can start. The
// menu sits on the line itself, beside the caret, so it covers no text.
const shouldShowOnEmptyLine: FloatingMenuProps["shouldShow"] = ({ editor, state }) =>
  canFormat(editor, state) && isOnEmptyLine(state.selection);

/** A toggle when `active` is set, a plain button otherwise. */
function ToolbarButton({
  label,
  title = label,
  active,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  // A native title, not <Tooltip>: the menus detach the toolbar without
  // unmounting it, which would leave a hovered button's tooltip on screen.
  return (
    <Button
      size="icon"
      variant="ghost"
      title={title}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-7 w-7 rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        active && "bg-foreground/10 text-foreground"
      )}
    >
      {children}
    </Button>
  );
}

const Separator = () => <div className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />;

function FormatToolbar({
  editor,
  dropdown,
}: {
  editor: Editor;
  dropdown: ReturnType<typeof useMenuDropdown>;
}) {
  const { t } = useTranslation();
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      actions: Object.fromEntries(
        [...MARKS, ...BLOCKS].map(({ key }) => [key, current.isActive(key)])
      ) as Record<string, boolean>,
      heading: HEADING_LEVELS.find((level) => current.isActive("heading", { level })) ?? 0,
    }),
  });

  const run = (command: ChainCommand) => runCommand(editor, command);
  const label = (key: string) => t(`notes.editor.format.${key}`);
  const actionButton = (action: FormatAction) => (
    <ToolbarButton
      key={action.key}
      label={label(action.key)}
      title={t("notes.editor.format.withShortcut", {
        action: label(action.key),
        shortcut: formatHotkeyLabel(action.shortcut),
      })}
      active={active.actions[action.key]}
      onClick={() => run(action.run)}
    >
      <action.icon size={15} />
    </ToolbarButton>
  );

  return (
    <div
      role="group"
      aria-label={label("toolbar")}
      className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg"
      // Keep focus and the selection in the editor: the commands apply to it.
      onMouseDown={(event) => event.preventDefault()}
    >
      {MARKS.map(actionButton)}
      <Separator />
      <DropdownMenu open={dropdown.open} onOpenChange={dropdown.setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            title={label("textStyle")}
            aria-label={label("textStyle")}
            className={cn(
              "h-7 gap-0.5 rounded-md px-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              active.heading > 0 && "bg-foreground/10 text-foreground"
            )}
          >
            <Heading size={15} />
            <ChevronDown size={11} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          container={dropdown.container}
          align="start"
          className="min-w-40 p-1"
          onCloseAutoFocus={refocusEditor(editor)}
        >
          {TEXT_STYLES.map((style) => (
            <DropdownMenuItem
              key={style.key}
              className="text-xs gap-2 rounded-md px-2 py-1.5"
              onSelect={() => run(style.run)}
            >
              <span className="flex-1">{label(style.key)}</span>
              {active.heading === style.level && <Check size={12} />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Separator />
      {BLOCKS.map(actionButton)}
      <Separator />
      <ToolbarButton
        label={label("table")}
        onClick={() => {
          editor.commands.focus();
          insertEmptyTable(editor);
        }}
      >
        <Table size={15} />
      </ToolbarButton>
    </div>
  );
}

/** Marks, text style, lists and tables for selected text or an empty line. */
export function RichTextEditorFormatMenu({ editor }: { editor: Editor }) {
  const onSelection = useMenuDropdown();
  const onEmptyLine = useMenuDropdown();
  useHideOnFocusLeave(editor, MENU_KEYS);
  return (
    <>
      <BubbleMenu
        ref={onSelection.menuRef}
        editor={editor}
        pluginKey={SELECTION_MENU}
        shouldShow={shouldShowOnSelection}
        options={onSelection.options}
      >
        <FormatToolbar editor={editor} dropdown={onSelection} />
      </BubbleMenu>
      <FloatingMenu
        ref={onEmptyLine.menuRef}
        className="rich-text-editor-line-menu"
        editor={editor}
        pluginKey={LINE_MENU}
        shouldShow={shouldShowOnEmptyLine}
        options={onEmptyLine.options}
      >
        <FormatToolbar editor={editor} dropdown={onEmptyLine} />
      </FloatingMenu>
    </>
  );
}

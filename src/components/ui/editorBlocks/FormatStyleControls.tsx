/**
 * text style controls added to the editor's existing
 * formatting toolbar (shown over selected text and on an empty line):
 * highlight, subscript, superscript, text colour, font, alignment, ruby text.
 * Styled to match the toolbar's own buttons.
 */
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Check,
  ChevronDown,
  FontFamily,
  Highlighter,
  RubyText,
  Subscript,
  Superscript,
  TextColor,
} from "../../icons";
import { cn } from "../../lib/utils";
import { Button } from "../button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import {
  refocusEditor,
  runCommand,
  type ChainCommand,
  useMenuDropdown,
} from "../RichTextEditorMenus";
import { COLORS, FONTS } from "./SlashMenu";
import { promptInline } from "./inlinePrompt";
import { tb } from "./translate";

type Dropdown = ReturnType<typeof useMenuDropdown>;
const ALIGNS = ["left", "center", "right", "justify"] as const;
const BUTTON =
  "h-7 w-7 rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground";
const TRIGGER =
  "h-7 gap-0.5 rounded-md px-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground";

const ALIGN_ICONS = {
  left: AlignLeft,
  center: AlignCenter,
  right: AlignRight,
  justify: AlignJustify,
} as const;
const AlignIcon = ({ align }: { align: string }) => {
  const Icon = ALIGN_ICONS[align as keyof typeof ALIGN_ICONS] ?? AlignLeft;
  return <Icon size={15} />;
};
/** Text colour icon with the current colour shown as a bar under it. */
const ColorIcon = ({ color }: { color?: string }) => (
  <span className="relative inline-flex">
    <TextColor size={15} />
    {color && (
      <span
        aria-hidden="true"
        className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full"
        style={{ background: color }}
      />
    )}
  </span>
);

function IconButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(BUTTON, active && "bg-foreground/10 text-foreground")}
    >
      {children}
    </Button>
  );
}

function StyleDropdown({
  id,
  dropdown,
  editor,
  title,
  active,
  icon,
  children,
}: {
  id: string;
  dropdown: Dropdown;
  editor: Editor;
  title: string;
  active?: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <DropdownMenu
      open={dropdown.extraOpen === id}
      onOpenChange={(open) => {
        if (open) dropdown.setOpen(false);
        dropdown.setExtraOpen(open ? id : null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          title={title}
          aria-label={title}
          className={cn(TRIGGER, active && "bg-foreground/10 text-foreground")}
        >
          {icon}
          <ChevronDown size={11} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={dropdown.container}
        align="start"
        className="min-w-40 p-1"
        onCloseAutoFocus={refocusEditor(editor)}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ITEM = "text-xs gap-2 rounded-md px-2 py-1.5";

export function FormatStyleControls({ editor, dropdown }: { editor: Editor; dropdown: Dropdown }) {
  useTranslation(); // re-render on UI language change
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      highlight: e.isActive("highlight"),
      subscript: e.isActive("subscript"),
      superscript: e.isActive("superscript"),
      ruby: e.isActive("rubyText"),
      color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
      font: (e.getAttributes("textStyle").fontFamily as string | undefined) ?? null,
      align: ALIGNS.find((a) => a !== "left" && e.isActive({ textAlign: a })) ?? "left",
    }),
  });
  const run = (command: ChainCommand) => runCommand(editor, command);
  const c = (chain: any) => chain; // commands from these extensions aren't in Tiptap's ChainedCommands types

  return (
    <>
      <IconButton
        title={`${tb("toolbar.highlight")} (⌘⇧H)`}
        active={state.highlight}
        onClick={() => run((ch) => c(ch).toggleHighlight())}
      >
        <Highlighter size={15} />
      </IconButton>
      <IconButton
        title={`${tb("toolbar.subscript")} (⌘,)`}
        active={state.subscript}
        onClick={() => run((ch) => c(ch).toggleSubscript())}
      >
        <Subscript size={15} />
      </IconButton>
      <IconButton
        title={`${tb("toolbar.superscript")} (⌘.)`}
        active={state.superscript}
        onClick={() => run((ch) => c(ch).toggleSuperscript())}
      >
        <Superscript size={15} />
      </IconButton>

      <StyleDropdown
        id="color"
        dropdown={dropdown}
        editor={editor}
        title={tb("toolbar.color")}
        active={!!state.color}
        icon={<ColorIcon color={state.color ?? undefined} />}
      >
        <DropdownMenuItem className={ITEM} onSelect={() => run((ch) => c(ch).unsetColor())}>
          <span className="h-3 w-3 rounded-full border border-border" />
          <span className="flex-1">{tb("colors.default")}</span>
          {!state.color && <Check size={12} />}
        </DropdownMenuItem>
        {COLORS.map(([key, value]) => (
          <DropdownMenuItem
            key={value}
            className={ITEM}
            onSelect={() => run((ch) => c(ch).setColor(value))}
          >
            <span className="h-3 w-3 rounded-full" style={{ background: value }} />
            <span className="flex-1" style={{ color: value }}>
              {tb(`colors.${key}`)}
            </span>
            {state.color === value && <Check size={12} />}
          </DropdownMenuItem>
        ))}
      </StyleDropdown>

      <StyleDropdown
        id="font"
        dropdown={dropdown}
        editor={editor}
        title={tb("toolbar.font")}
        active={!!state.font}
        icon={<FontFamily size={15} />}
      >
        <DropdownMenuItem className={ITEM} onSelect={() => run((ch) => c(ch).unsetFontFamily())}>
          <span className="flex-1">{tb("fonts.default")}</span>
          {!state.font && <Check size={12} />}
        </DropdownMenuItem>
        {FONTS.map(([key, value]) => (
          <DropdownMenuItem
            key={value}
            className={ITEM}
            onSelect={() => run((ch) => c(ch).setFontFamily(value))}
          >
            <span className="flex-1" style={{ fontFamily: value }}>
              {tb(`fonts.${key}`)}
            </span>
            {state.font === value && <Check size={12} />}
          </DropdownMenuItem>
        ))}
      </StyleDropdown>

      <StyleDropdown
        id="align"
        dropdown={dropdown}
        editor={editor}
        title={tb("toolbar.alignment")}
        active={state.align !== "left"}
        icon={<AlignIcon align={state.align} />}
      >
        {ALIGNS.map((a) => (
          <DropdownMenuItem
            key={a}
            className={ITEM}
            onSelect={() => run((ch) => c(ch).setTextAlign(a))}
          >
            <AlignIcon align={a} />
            <span className="flex-1">{tb(`align.${a}`)}</span>
            {state.align === a && <Check size={12} />}
          </DropdownMenuItem>
        ))}
      </StyleDropdown>

      <IconButton
        title={tb("toolbar.ruby")}
        active={state.ruby}
        onClick={async () => {
          if (state.ruby) return run((ch) => c(ch).unsetRubyText());
          const hasSelection = !editor.state.selection.empty;
          const answer = await promptInline(editor, {
            placeholder: tb(hasSelection ? "prompt.reading" : "prompt.textReading"),
          });
          if (!answer) return;
          if (hasSelection) return run((ch) => c(ch).setRubyText({ rt: answer }));
          const [base, rt] = answer.split("|").map((s) => s.trim());
          if (base && rt)
            editor
              .chain()
              .focus()
              .insertContent({
                type: "text",
                text: base,
                marks: [{ type: "rubyText", attrs: { rt } }],
              })
              .run();
        }}
      >
        <RubyText size={15} />
      </IconButton>
    </>
  );
}

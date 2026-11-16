import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, CornerDownLeft, Upload } from "../icons";
import { Input } from "../ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import type { ShareTarget } from "../../services/sharedDictionaryActions";
import { isTermLikeSharedWord } from "../../utils/sharedDictionaryHints";

export type AddTarget = ShareTarget | "personal";

export interface AddTargetOption {
  target: AddTarget;
  label: string;
}

interface DictionaryAddFieldProps {
  target: AddTarget;
  targets: AddTargetOption[];
  onTargetChange: (target: AddTarget) => void;
  // Resolves false when the words weren't added, which puts them back in the
  // field. The field clears as soon as they're submitted.
  onAdd: (text: string) => Promise<boolean>;
  // Whether one typed word is already in the target list.
  isInTarget: (word: string) => boolean;
  // Whether that copy is one the member hid, so the list doesn't show it.
  isHiddenInTarget: (word: string) => boolean;
  // Resolves true once the hidden copy is back, which clears the field.
  onUnhide: (word: string) => Promise<boolean>;
  onImport: () => void;
  importMenu?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  // A list that takes no new words (paused) keeps the field, dimmed and inert.
  disabled?: boolean;
}

export function DictionaryAddField({
  target,
  targets,
  onTargetChange,
  onAdd,
  isInTarget,
  isHiddenInTarget,
  onUnhide,
  onImport,
  importMenu,
  inputRef,
  disabled = false,
}: DictionaryAddFieldProps): ReactElement {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const noticeId = useId();
  // The list an add was sent to may no longer be the one the field adds to
  // when its answer comes back.
  const currentTarget = useRef(target);
  useEffect(() => {
    currentTarget.current = target;
  }, [target]);

  const targetLabel =
    targets.find((option) => option.target === target)?.label ?? t("dictionary.shared.personal");
  const trimmed = text.trim();
  // A comma list adds whatever is new; only a single known word is refused.
  const alreadyAdded = trimmed !== "" && !trimmed.includes(",") && isInTarget(trimmed);
  // "Already in" would point at a word the list doesn't show, so a hidden copy
  // says so and offers to bring it back instead.
  const hiddenForYou = alreadyAdded && isHiddenInTarget(trimmed);
  // A teammate's dictation leaves these out, so a shared list doesn't take them.
  // A comma list goes through and reports the words it left out.
  const notTermLike =
    target !== "personal" &&
    !trimmed.includes(",") &&
    trimmed !== "" &&
    !isTermLikeSharedWord(trimmed);
  const notice = hiddenForYou
    ? t("dictionary.shared.add.hiddenForYou", { list: targetLabel })
    : alreadyAdded
      ? t("dictionary.shared.alreadyIn", { list: targetLabel })
      : notTermLike
        ? t("dictionary.shared.notTermLike")
        : null;
  const canAdd = trimmed !== "" && notice === null && !busy && !disabled;

  const runBusy = async (action: () => Promise<boolean>): Promise<void> => {
    setBusy(true);
    try {
      if (await action()) setText("");
    } finally {
      setBusy(false);
    }
  };

  // A shared add waits on the API, so the field clears at once and the next
  // word can be typed while it runs. A refused add puts its text back, unless
  // something new was typed meanwhile or the field now adds to another list,
  // where Enter would send it; its toast names the words either way.
  const submit = async (): Promise<void> => {
    if (!canAdd) return;
    const submitted = text;
    const submittedTarget = target;
    setText("");
    let added = false;
    try {
      added = await onAdd(submitted);
    } finally {
      if (!added && currentTarget.current === submittedTarget) {
        setText((current) => (current.trim() === "" ? submitted : current));
      }
    }
  };

  const unhide = async (): Promise<void> => {
    if (!hiddenForYou || busy || disabled) return;
    await runBusy(() => onUnhide(trimmed));
  };

  return (
    <div
      className={cn(
        "flex h-9 items-center gap-2 rounded-lg border border-default/70 bg-surface-primary ps-3 pe-1.5 transition-colors focus-within:border-brand-solid focus-within:ring-2 focus-within:ring-brand-solid/10 dark:bg-surface-secondary",
        disabled && "opacity-60"
      )}
    >
      <Input
        dir="auto"
        ref={inputRef}
        disabled={disabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter that commits an IME composition isn't a submit.
          if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit();
        }}
        placeholder={t("dictionary.shared.add.placeholder")}
        aria-invalid={notice !== null || undefined}
        aria-describedby={notice !== null ? noticeId : undefined}
        className="input-inline h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-xs shadow-none placeholder:text-primary/45 hover:border-0 focus-visible:ring-0"
      />
      {notice !== null ? (
        <>
          <span
            id={noticeId}
            title={notice}
            className={cn(
              "min-w-0 truncate text-[11px]",
              notTermLike && !alreadyAdded ? "text-red" : "text-primary/45"
            )}
          >
            {notice}
          </span>
          {hiddenForYou && (
            <button
              type="button"
              onClick={() => void unhide()}
              disabled={busy || disabled}
              aria-label={t("dictionary.shared.actions.unhideWord", { word: trimmed })}
              className="shrink-0 text-[11px] text-brand-solid transition-colors enabled:hover:text-brand-solid/80"
            >
              {t("dictionary.shared.actions.unhide")}
            </button>
          )}
        </>
      ) : (
        trimmed !== "" && (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canAdd}
            aria-label={t("dictionary.addWord")}
            className="flex shrink-0 items-center gap-1 text-[11px] text-primary/45 transition-colors enabled:hover:text-brand-solid"
          >
            {t("dictionary.add")}
            <CornerDownLeft size={11} />
          </button>
        )
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            disabled={disabled}
            aria-label={t("dictionary.shared.add.chooseList")}
            className="flex h-6 max-w-48 shrink-0 items-center gap-1 rounded-[5px] border border-text-primary/8 bg-text-primary/3 px-2 text-[11px] text-primary/80 transition-colors enabled:hover:bg-text-primary/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-solid/20"
          >
            <span dir="auto" className="truncate">
              {t("dictionary.shared.add.to", { list: targetLabel })}
            </span>
            <ChevronDown size={11} className="shrink-0 text-primary/45" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44 rounded-lg p-1">
          {targets.map((option) => (
            <DropdownMenuItem
              key={option.target ?? "workspace"}
              onSelect={() => onTargetChange(option.target)}
              className="gap-2 rounded-md px-2 py-1.5 text-xs"
            >
              <span dir="auto" className="flex-1 truncate">
                {option.label}
              </span>
              {option.target === target && <Check size={12} className="text-brand-solid" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="h-4 w-px bg-text-primary/10" />
      {importMenu ?? (
        <button
          type="button"
          onClick={onImport}
          disabled={disabled}
          aria-label={t("dictionary.importWords")}
          className="grid size-6 shrink-0 place-items-center rounded-[5px] text-primary/45 transition-colors enabled:hover:bg-text-primary/5 enabled:hover:text-primary/70"
        >
          <Upload size={13} />
        </button>
      )}
    </div>
  );
}

import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Trash2 } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { SkillIcon } from "../skills/SkillIcon";
import { APPROVAL_CARD_CLASS } from "./ApprovalCard";
import { useSkillChatActions } from "./skillChatActions";
import { problemKey } from "../skills/skillCopy";
import { useSkillsStore } from "../../stores/skillsStore";
import {
  saveSkillApproval,
  skipSkillApproval,
  undoSkillApproval,
  updateSkillDraft,
  type SkillApprovalEntry,
  type SkillCreateApproval,
  type SkillUpdateApproval,
} from "../../stores/skillApprovalStore";
import { foldUnchanged, lineDiff } from "../../utils/lineDiff";
import { formatShortDate, normalizeDbDate } from "../../utils/dateFormatting";

const FIELD_CLASS = "w-full rounded-md border border-border/70 bg-background px-2 py-1";
const INLINE_LINK_CLASS = "h-auto px-1.5 py-0";
const EDITOR_CLASS = "h-56 font-mono text-[11px] leading-relaxed";
const PREVIEW_CLASS =
  "mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border/70 bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/85";

function ExpandToggle({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="inline-flex items-center gap-1 rounded-sm text-xs text-primary/80 outline-none hover:text-primary focus-visible:ring-1 focus-visible:ring-primary/30"
    >
      <ChevronDown
        className={cn("h-3 w-3 transition-transform duration-200", open && "rotate-180")}
      />
      {children}
    </button>
  );
}

function CreateSkillBody({
  entry,
  editing,
}: {
  entry: SkillCreateApproval;
  editing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const playKey = useSkillsStore((state) => state.iconPlays[entry.name] ?? 0);
  // Saving switches the skill on, which only needs saying for one that is off now.
  const existingOff = useSkillsStore((state) =>
    state.skills.some((skill) => skill.name === entry.name && !(skill.enabled && skill.valid))
  );
  const [showFull, setShowFull] = useState(false);
  const { draft } = entry;
  return (
    <>
      <p className="font-medium text-foreground">{t("skills.approval.createHeader")}</p>
      <p className="text-xs text-muted-foreground">
        {entry.replacesExisting
          ? t(
              existingOff
                ? "skills.approval.replacesExistingTurnsOn"
                : "skills.approval.replacesExisting"
            )
          : t("skills.approval.newSkill")}
      </p>
      <div className="mt-2 flex items-start gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/5 text-primary dark:bg-primary/10">
          <SkillIcon size={14} playKey={playKey} />
        </div>
        <div className="min-w-0">
          <p className="font-medium" dir="auto">
            {draft.title}
          </p>
          <p dir="auto">{draft.description}</p>
        </div>
      </div>

      {editing && (
        <div className="mt-2 space-y-2">
          <input
            type="text"
            aria-label={t("skills.approval.nameLabel")}
            className={FIELD_CLASS}
            dir="auto"
            value={draft.title}
            onChange={(event) => updateSkillDraft(entry.key, { title: event.target.value })}
          />
          <textarea
            aria-label={t("skills.approval.descriptionLabel")}
            className={cn(FIELD_CLASS, "min-h-16")}
            dir="auto"
            value={draft.description}
            onChange={(event) => updateSkillDraft(entry.key, { description: event.target.value })}
          />
        </div>
      )}

      <div className="mt-2">
        <ExpandToggle open={showFull} onToggle={() => setShowFull((open) => !open)}>
          {t("skills.approval.seeFull")}
        </ExpandToggle>
        {/* Everything Save writes: the instructions, then each file. */}
        {showFull && (
          <>
            <pre dir="auto" className={PREVIEW_CLASS}>
              {draft.instructions}
            </pre>
            {draft.files.map((file) => (
              <div key={file.path} className="mt-2">
                <p dir="ltr" className="font-mono text-[11px] text-muted-foreground">
                  {file.path}
                </p>
                <pre dir="auto" className={PREVIEW_CLASS}>
                  {file.content}
                </pre>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

interface ChangedPart {
  key: string;
  label: string;
  before: string;
  after: string;
}

// One diff per part the change touches: the description, the instructions and each file.
function changedParts(entry: SkillUpdateApproval, descriptionLabel: string): ChangedPart[] {
  const { draft, current } = entry;
  return [
    ...(draft.description !== undefined
      ? [
          {
            key: "description",
            label: descriptionLabel,
            before: current.description,
            after: draft.description,
          },
        ]
      : []),
    ...(draft.instructions !== undefined
      ? [
          {
            key: "SKILL.md",
            label: "SKILL.md",
            before: current.instructions,
            after: draft.instructions,
          },
        ]
      : []),
    ...draft.files.map((file) => ({
      key: file.path,
      label: file.path,
      before: current.files[file.path] ?? "",
      after: file.content,
    })),
  ];
}

// Unchanged runs fold to a count, and the part scrolls past a fixed height, so a one-line change
// to a long file stays short in the narrow voice panel.
function DiffPart({ part }: { part: ChangedPart }): ReactElement {
  const { t } = useTranslation();
  // Every keystroke in the editor renders the card again; the diff only changes with the text.
  const lines = useMemo(
    () => foldUnchanged(lineDiff(part.before, part.after)),
    [part.before, part.after]
  );
  return (
    <div
      data-diff-part={part.key}
      dir="ltr"
      className="mt-1.5 max-h-72 overflow-auto rounded-md border border-border/70 bg-background font-mono text-[11px] leading-5"
    >
      <div className="sticky top-0 border-b border-border/60 bg-background px-2.5 py-1 text-muted-foreground/80">
        {part.label}
      </div>
      {lines.map((line, index) =>
        line.kind === "fold" ? (
          <div key={index} data-diff="fold" className="px-2.5 text-muted-foreground/70">
            {t("skills.approval.unchangedLines", { count: line.count })}
          </div>
        ) : (
          <div
            key={index}
            data-diff={line.kind}
            className={cn(
              "flex gap-2 px-2.5",
              line.kind === "+" && "bg-success/10 text-success",
              line.kind === "-" &&
                "bg-destructive/10 text-destructive line-through decoration-destructive/40",
              line.kind === " " && "text-muted-foreground"
            )}
          >
            <span aria-hidden="true" className="w-2 shrink-0 select-none">
              {line.kind === " " ? "" : line.kind}
            </span>
            {line.kind !== " " && (
              <span className="sr-only">
                {t(line.kind === "+" ? "skills.approval.added" : "skills.approval.removed")}
              </span>
            )}
            <span className="whitespace-pre-wrap">{line.text}</span>
          </div>
        )
      )}
    </div>
  );
}

function UpdateSkillBody({
  entry,
  editing,
}: {
  entry: SkillUpdateApproval;
  editing: boolean;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [showChanges, setShowChanges] = useState(false);
  const editorId = useId();
  const { draft, learnedFrom } = entry;
  const learnedOn =
    learnedFrom &&
    (normalizeDbDate(learnedFrom.createdAt).toDateString() === new Date().toDateString()
      ? t("skills.approval.today")
      : formatShortDate(learnedFrom.createdAt, i18n.language));
  const setFile = (path: string, content: string): void =>
    updateSkillDraft(entry.key, {
      files: draft.files.map((file) => (file.path === path ? { path, content } : file)),
    });
  return (
    <>
      <p className="font-medium text-foreground">{t("skills.approval.updateHeader")}</p>
      <p className="text-xs text-muted-foreground" dir="auto">
        {entry.displayName}
      </p>
      <p className="mt-2 font-medium" dir="auto">
        {entry.intent}
      </p>

      {editing && (
        <div className="mt-2 space-y-2">
          {draft.description !== undefined && (
            <textarea
              aria-label={t("skills.approval.descriptionLabel")}
              className={cn(FIELD_CLASS, "min-h-16")}
              dir="auto"
              value={draft.description}
              onChange={(event) => updateSkillDraft(entry.key, { description: event.target.value })}
            />
          )}
          {/* Text boxes that wrap: in the narrow card, a line-numbered editor's unwrapped
              lines would scroll sideways. */}
          {draft.instructions !== undefined && (
            <textarea
              id={`${editorId}-instructions`}
              aria-label="SKILL.md"
              className={cn(FIELD_CLASS, EDITOR_CLASS)}
              dir="auto"
              spellCheck={false}
              value={draft.instructions}
              onChange={(event) =>
                updateSkillDraft(entry.key, { instructions: event.target.value })
              }
            />
          )}
          {draft.files.map((file, index) => (
            <textarea
              key={file.path}
              id={`${editorId}-file-${index}`}
              aria-label={file.path}
              className={cn(FIELD_CLASS, EDITOR_CLASS)}
              dir="auto"
              spellCheck={false}
              value={file.content}
              onChange={(event) => setFile(file.path, event.target.value)}
            />
          ))}
        </div>
      )}

      {entry.removals.length > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-1.5 text-xs text-foreground/85 dark:bg-destructive/10">
          <Trash2 size={12} className="mt-0.5 shrink-0 text-destructive/80" />
          <p dir="auto">
            <span className="font-medium text-destructive">{t("skills.approval.removes")}</span>{" "}
            {entry.removals.join("; ")}
          </p>
        </div>
      )}
      {learnedFrom && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("skills.approval.learnedFrom", { title: learnedFrom.title, date: learnedOn })}
        </p>
      )}

      <div className="mt-2">
        <ExpandToggle open={showChanges} onToggle={() => setShowChanges((open) => !open)}>
          {t("skills.approval.seeChanges")}
        </ExpandToggle>
        {showChanges &&
          changedParts(entry, t("skills.approval.descriptionLabel")).map((part) => (
            <DiffPart key={part.key} part={part} />
          ))}
      </div>
    </>
  );
}

// The draft lives in the store, so edit mode only changes how it is shown: Save always
// writes exactly what the card displays.
export function SkillApprovalCard({ entry }: { entry: SkillApprovalEntry }): ReactElement {
  const { t } = useTranslation();
  const { openSkill } = useSkillChatActions();
  const [editing, setEditing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const showEditor = editing && entry.state === "pending";
  const isUpdate = entry.kind === "update";

  // Save, Skip and Undo remove the button that had focus; the card keeps it, so keyboard
  // and screen-reader users land on the result.
  const leaveEditingAndFocusCard = (): void => {
    setEditing(false);
    cardRef.current?.focus();
  };

  // Esc while editing ends editing and keeps the draft. It must not reach the assistant
  // panel, whose Esc cancels the whole turn and withdraws the card.
  const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // An Esc that only ends an input method's composition stays with the text field.
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    setEditing(false);
  };

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-approval-card={entry.key}
      data-state={entry.state}
      onKeyDown={showEditor ? onEditorKeyDown : undefined}
      className={APPROVAL_CARD_CLASS}
    >
      {entry.kind === "update" ? (
        <UpdateSkillBody entry={entry} editing={showEditor} />
      ) : (
        <CreateSkillBody entry={entry} editing={showEditor} />
      )}

      {/* One live region for every outcome, rendered from the start so a screen reader
          announces each change. */}
      <div role="status" aria-live="polite" className="text-xs">
        {entry.state === "pending" && entry.problems?.[0] && (
          <p className="mt-2 text-warning">
            {t(problemKey(entry.problems[0]), entry.problems[0].values)}
          </p>
        )}
        {entry.state === "saving" && (
          <p className="mt-2 text-muted-foreground">{t("skills.approval.saving")}</p>
        )}
        {entry.state === "saved" && entry.versionId && (
          <p className="mt-2 text-foreground">
            {t("skills.approval.updated")} ·
            <Button
              size="sm"
              variant="link"
              className={INLINE_LINK_CLASS}
              onClick={() => {
                cardRef.current?.focus();
                void undoSkillApproval(entry.key);
              }}
            >
              {t("skills.approval.undo")}
            </Button>
          </p>
        )}
        {entry.state === "saved" && entry.undoFailed && (
          <p className="mt-1 text-destructive">{t("skills.approval.undoFailed")}</p>
        )}
        {entry.state === "saved" && !entry.versionId && (
          <p className="mt-2 text-foreground">
            {t("skills.approval.saved")}
            {openSkill && (
              <>
                {" ·"}
                <Button
                  size="sm"
                  variant="link"
                  className={INLINE_LINK_CLASS}
                  onClick={() => openSkill(entry.name)}
                >
                  {t("skills.approval.openSkill")}
                </Button>
              </>
            )}
          </p>
        )}
        {entry.state === "undone" && (
          <p className="mt-2 text-muted-foreground">{t("skills.approval.undone")}</p>
        )}
        {entry.state === "changed_since" && (
          <p className="mt-2 text-muted-foreground">{t("skills.approval.undoStale")}</p>
        )}
        {entry.state === "outdated" && (
          <p className="mt-2 text-muted-foreground">{t("skills.approval.outdated")}</p>
        )}
        {entry.state === "skipped" && (
          <p className="mt-2 text-muted-foreground">
            {isUpdate ? t("skills.approval.skippedUpdate") : t("skills.approval.skippedCreate")}
          </p>
        )}
        {entry.state === "failed" && (
          <p className="mt-2 text-destructive">{t("skills.approval.failed")}</p>
        )}
        {entry.state === "not_saved" && (
          <p className="mt-2 text-muted-foreground">{t("skills.approval.notSaved")}</p>
        )}
      </div>

      {entry.state === "pending" && (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              leaveEditingAndFocusCard();
              void saveSkillApproval(entry.key);
            }}
          >
            {isUpdate ? t("skills.approval.update") : t("skills.approval.save")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing((value) => !value)}>
            {editing ? t("connectors.approval.doneEditing") : t("connectors.approval.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              leaveEditingAndFocusCard();
              skipSkillApproval(entry.key);
            }}
          >
            {t("common.skip")}
          </Button>
        </div>
      )}
    </div>
  );
}

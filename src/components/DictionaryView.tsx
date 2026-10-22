import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Download, NotebookPen, PanelRight, Plus, Sparkles } from "./icons";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { PAGE_CONTENT_WIDTH_CLASS } from "./ui/pageWidth";
import { cn } from "./lib/utils";
import { CARD_SURFACE_CLASS } from "./ui/surfaces";
import { ConfirmDialog } from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import SnippetsView from "./SnippetsView";
import DictionaryEmptyIllustration from "./DictionaryEmptyIllustration";
import { DictionaryListPicker } from "./dictionary/DictionaryListPicker";
import { DictionaryToolbar } from "./dictionary/DictionaryToolbar";
import {
  DictionaryAddField,
  type AddTarget,
  type AddTargetOption,
} from "./dictionary/DictionaryAddField";
import { DictionaryWordList, type WordListSelection } from "./dictionary/DictionaryWordList";
import { useDictionaryActions } from "./dictionary/useDictionaryActions";
import { useDictionarySelection } from "./dictionary/useDictionarySelection";
import { SelectionActionBar } from "./dictionary/SelectionActionBar";
import { ShareWordsPopover } from "./dictionary/ShareWordsPopover";
import {
  SharedDictionaryLocked,
  SharedDictionaryUpsell,
  type LockedAccessState,
} from "./dictionary/SharedDictionaryLocked";
import { SharedListEmpty } from "./dictionary/SharedListEmpty";
import {
  allWordsArePersonal,
  buildPicker,
  defaultAddTarget,
  filterRows,
  resolveSharedAccessState,
  rowsForList,
  shareTargetsFor,
  SORT_LABEL_KEYS,
  type SortKey,
} from "./dictionary/dictionaryViewModel";
import { useSettings } from "../hooks/useSettings";
import { useWorkspace } from "../hooks/useWorkspace";
import { useAuth } from "../hooks/useAuth";
import { useSharedDictionaryStore, type ListKey } from "../stores/sharedDictionaryStore";
import { getAgentName } from "../utils/agentName";
import { parseDictionaryImportText } from "../helpers/dictionaryImport";
import { dictionaryWordKey, getDictionaryHintTiers } from "../utils/snippets";
import { formatDictionaryPrompt, WHISPER_DECODER_PROMPT_CHARS } from "../utils/dictionaryPromptCap";
import { canManageWorkspace } from "../lib/spacePermissions";

const SORT_STORAGE_KEY = "dictionarySort";
const ADD_TARGET_STORAGE_KEY = "dictionaryAddTarget";
// A burst of changes (a sync pass, a bulk action in the other window) rereads the mirror once.
const CHANGED_RELOAD_DELAY_MS = 250;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the choice lasts for this visit only.
  }
}

function readSort(): SortKey {
  const stored = readStorage(SORT_STORAGE_KEY);
  return stored !== null && Object.hasOwn(SORT_LABEL_KEYS, stored) ? (stored as SortKey) : "az";
}

// The list last added to, and the workspace it was picked in: null (the
// workspace list) means a different list in every workspace, so it must never
// carry over to another one and share a word company-wide by accident.
interface RememberedTarget {
  workspaceId: string | null;
  target: AddTarget;
}

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

// undefined when nothing valid is stored.
function readRememberedTarget(): RememberedTarget | undefined {
  const stored = readStorage(ADD_TARGET_STORAGE_KEY);
  if (stored === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { workspaceId, target } = parsed as Record<string, unknown>;
    return isStringOrNull(workspaceId) && isStringOrNull(target)
      ? { workspaceId, target }
      : undefined;
  } catch {
    return undefined;
  }
}

const isSharedList = (list: ListKey): boolean => list !== "all" && list !== "personal";
const sameWord = (left: string, right: string): boolean =>
  dictionaryWordKey(left) === dictionaryWordKey(right);

interface DictionaryViewProps {
  // Opens Plans & Billing from a Shared list's upsell.
  onUpgrade: () => void;
}

export default function DictionaryView({ onUpgrade }: DictionaryViewProps): ReactElement {
  const { t } = useTranslation();
  const { customDictionary, updateCustomDictionary, snippets } = useSettings();
  const { active: workspace } = useWorkspace();
  const { isSignedIn, user } = useAuth();
  const agentName = getAgentName();

  const status = useSharedDictionaryStore((state) => state.status);
  const snapshot = useSharedDictionaryStore((state) => state.snapshot);
  const movedPersonal = useSharedDictionaryStore((state) => state.movedPersonal);
  const storeSyncing = useSharedDictionaryStore((state) => state.syncing);
  const lastSyncedAt = useSharedDictionaryStore((state) => state.lastSyncedAt);
  const requestedList = useSharedDictionaryStore((state) => state.requestedList);

  const [tab, setTab] = useState("dictionary");
  const [list, setList] = useState<ListKey>(requestedList ?? "all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>(readSort);
  const [rememberedTarget, setRememberedTarget] = useState<RememberedTarget | undefined>(
    readRememberedTarget
  );
  // A target picked from the chip holds for the list (and workspace) it was picked on.
  const [pickedTarget, setPickedTarget] = useState<{
    list: ListKey;
    target: AddTarget;
    workspaceId: string | null;
  } | null>(null);
  const [bulkText, setBulkText] = useState("");
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [hidingSelected, setHidingSelected] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // The words the share popover is open for, and the control it opened from.
  const [shareRequest, setShareRequest] = useState<{
    words: string[];
    anchor: HTMLElement;
  } | null>(null);
  // Bottom padding the list keeps clear for the floating selection bar.
  const [selectionBarClearance, setSelectionBarClearance] = useState(56);
  // The list whose checkboxes show with nothing ticked yet ("Share from Personal").
  const [selectModeList, setSelectModeList] = useState<ListKey | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback((): HTMLElement | null => scrollRef.current, []);

  // A window's snapshot only refreshes where the last sync pass ran, so the page
  // rereads the local mirror whenever it opens.
  useEffect(() => {
    void useSharedDictionaryStore.getState().reload();
  }, []);

  // The other window, or a sync pass, changed the mirror: reread it. Row keys
  // are stable across the reread, so the selection and an open editor survive.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dispose = window.electronAPI?.onSyncEvent?.(({ name, payload }) => {
      if (name !== "shared-dictionary-changed") return;
      const changed = (payload as { workspaceId?: unknown } | undefined)?.workspaceId;
      const store = useSharedDictionaryStore.getState();
      if (changed !== undefined && changed !== store.workspaceId) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => void useSharedDictionaryStore.getState().reload(),
        CHANGED_RELOAD_DELAY_MS
      );
    });
    return () => {
      clearTimeout(timer);
      dispose?.();
    };
  }, []);

  // The arrival toast's "View words" can ask for a list while the page is open,
  // even on the Snippets tab.
  useEffect(() => {
    if (!requestedList) return;
    setTab("dictionary");
    setList(requestedList);
    // A search left over from before would filter out the words it asked to show.
    setSearch("");
    useSharedDictionaryStore.getState().setRequestedList(null);
  }, [requestedList]);

  const workspaceId = workspace?.id ?? null;
  const workspaceName = workspace?.name ?? "";
  const access = resolveSharedAccessState({
    status,
    signedIn: isSignedIn,
    workspace,
    serverPaused: snapshot?.meta?.paused ?? null,
    hasWords:
      (snapshot?.entries.length ?? 0) > 0 ||
      (snapshot?.meta?.scopes ?? []).some((scope) => scope.word_count > 0),
  });

  // Same membership rule as agentNameDictionaryChanges: a stored spelling that
  // differs only by case is still the agent name's entry, so keep it hidden.
  const userWords = useMemo(() => {
    const agentWord = agentName.trim().toLowerCase();
    return customDictionary.filter((word) => word.trim().toLowerCase() !== agentWord);
  }, [customDictionary, agentName]);

  const pickerEntries = useMemo(
    () => buildPicker({ personal: userWords, movedPersonal, snapshot, workspaceName, access, t }),
    [userWords, movedPersonal, snapshot, workspaceName, access, t]
  );

  const canManage = workspace ? canManageWorkspace(workspace.role) : false;
  // Without the shared dictionary, All words would only repeat Personal, so the
  // page shows Personal alone, with no picker.
  const pickerShown = access !== "unavailable";
  // A list the member lost (a space they left) falls back to All words.
  const openList: ListKey = !pickerShown
    ? "personal"
    : pickerEntries.some((entry) => entry.key === list)
      ? list
      : "all";
  const openEntry = pickerEntries.find((entry) => entry.key === openList);
  const locked = isSharedList(openList) && access !== "available";
  const lockedAccess: LockedAccessState | null = locked && access !== "unavailable" ? access : null;
  const singleList = openList === "workspace" || openList.startsWith("space:");
  // A paused workspace keeps its words, so one of its lists opens dimmed and read-only;
  // every other locked list shows what Business gives instead.
  const readOnlyList = lockedAccess === "paused" && singleList;
  const scopes = snapshot?.meta?.scopes ?? [];

  // Sorted once per change to the list; a keystroke in the search only filters.
  const listRows = useMemo(
    () =>
      rowsForList(openList, {
        personal: userWords,
        movedPersonal,
        snapshot,
        workspaceName,
        currentUserId: user?.id ?? null,
        search: "",
        sort,
        access,
      }),
    [openList, userWords, movedPersonal, snapshot, workspaceName, user?.id, sort, access]
  );
  const rows = useMemo(() => filterRows(listRows, search), [listRows, search]);

  const selection = useDictionarySelection(rows, listRows);
  const { clear: clearTicked } = selection;
  // Hidden words can only be unhidden one by one, so that list has no checkboxes.
  const selectable = !locked && openList !== "hidden";
  const selectedRows = selectable ? selection.selectedRows : [];
  const selectedPersonal = selectedRows.filter((row) => row.kind === "personal");
  const selectedShared = selectedRows.filter((row) => row.kind === "shared");
  const selectMode = selectable && selectModeList === openList;
  const selectionActive = selectedRows.length > 0 || selectMode;

  const clearSelection = useCallback((): void => {
    clearTicked();
    setSelectModeList(null);
  }, [clearTicked]);

  useEffect(() => {
    clearTicked();
    setShareRequest(null);
    setSelectModeList((current) => (current === openList ? current : null));
  }, [openList, clearTicked]);

  // Esc clears from anywhere on the page. An open dialog or popover handles
  // Esc first and marks it handled, and a text field keeps it for itself.
  useEffect(() => {
    if (!selectionActive) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
      clearSelection();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectionActive, clearSelection]);

  const shareOptions = useMemo(
    () =>
      shareRequest && snapshot?.meta
        ? shareTargetsFor(shareRequest.words, snapshot, workspaceName, t)
        : [],
    [shareRequest, snapshot, workspaceName, t]
  );
  const canShare = access === "available" && !!snapshot?.meta && snapshot.meta.scopes.length > 0;

  const addTargets = useMemo((): AddTargetOption[] => {
    const personal: AddTargetOption = {
      target: "personal",
      label: t("dictionary.shared.personal"),
    };
    if (access !== "available" || !snapshot?.meta) return [personal];
    const shared = shareTargetsFor([], snapshot, workspaceName, t);
    return [personal, ...shared.map(({ target, label }) => ({ target, label }))];
  }, [access, snapshot, workspaceName, t]);

  const isWritable = (target: AddTarget | undefined): target is AddTarget =>
    target !== undefined && addTargets.some((option) => option.target === target);
  // Another workspace's choice reads as nothing remembered, which is Personal.
  const lastUsed =
    rememberedTarget?.workspaceId === workspaceId ? rememberedTarget.target : undefined;
  const preferredTarget =
    pickedTarget?.list === openList && pickedTarget.workspaceId === workspaceId
      ? pickedTarget.target
      : defaultAddTarget(openList, isWritable(lastUsed) ? lastUsed : undefined);
  const addTarget: AddTarget = isWritable(preferredTarget) ? preferredTarget : "personal";

  const listLabel = (target: AddTarget): string =>
    addTargets.find((option) => option.target === target)?.label ?? t("dictionary.shared.personal");

  const rememberTarget = (target: AddTarget): void => {
    const remembered: RememberedTarget = { workspaceId, target };
    setRememberedTarget(remembered);
    writeStorage(ADD_TARGET_STORAGE_KEY, JSON.stringify(remembered));
  };

  // Length of the user's own part of the STT prompt (words + snippet triggers,
  // comma-joined). Team words are left out: members can't edit them, and they
  // are dropped first, so Whisper keeps the personal words at the prompt's tail.
  // A Chinese script bias adds ~21 chars on top for zh-CN / zh-TW users.
  const promptChars = useMemo(
    () =>
      formatDictionaryPrompt([getDictionaryHintTiers({ customDictionary, snippets })[0]], Infinity)
        .length,
    [customDictionary, snippets]
  );

  const pendingImportCount = useMemo(() => parseDictionaryImportText(bulkText).length, [bulkText]);

  const actions = useDictionaryActions({
    workspaceId,
    workspaceName,
    customDictionary,
    userWords,
    agentName,
    updateCustomDictionary,
    movedPersonal,
    snapshot,
    access,
    listLabel,
  });
  const { visiblePersonal } = actions;

  const addWords = (text: string): Promise<boolean> => {
    rememberTarget(addTarget);
    return actions.addWords(text, addTarget);
  };

  const handleImport = async (): Promise<void> => {
    if (importing) return;
    setImporting(true);
    try {
      if (await addWords(bulkText)) {
        setBulkText("");
        setShowBulkImport(false);
      }
    } finally {
      setImporting(false);
    }
  };

  const wordListSelection: WordListSelection | undefined = selectable
    ? {
        isSelected: selection.isSelected,
        active: selectionActive,
        onToggle: (row, extend) => selection.toggle(row.key, extend),
        onSelectAll: selection.selectAll,
        onClear: clearSelection,
      }
    : undefined;

  // Delete only removes personal words, so the shared ones stay selected for
  // their own actions; the deleted rows leave the selection as they leave the list.
  const deleteSelectedPersonal = (): void => {
    actions.deletePersonalWords(selectedPersonal.map((row) => row.word));
    if (selectedShared.length === 0) clearSelection();
  };

  const hideSelected = async (): Promise<void> => {
    if (hidingSelected) return;
    setHidingSelected(true);
    try {
      if (await actions.setRowsHidden(selectedShared, true)) clearSelection();
    } finally {
      setHidingSelected(false);
    }
  };

  const shareRequested = async (
    targets: Parameters<typeof actions.shareWords>[1]
  ): Promise<void> => {
    if (!shareRequest) return;
    const shared = await actions.shareWords(shareRequest.words, targets);
    setShareRequest(null);
    // Words that didn't go stay selected, so sharing them again is one click.
    if (shared) clearSelection();
  };

  const selectList = (next: ListKey): void => {
    setList(next);
    setSearch("");
  };

  const personalView = openList === "all" || openList === "personal";
  // Where a list holds only personal words (Personal, or All words without any
  // shared ones), it gets Personal's Clear all and Export.
  const personalOnlyList =
    openList === "personal" || (openList === "all" && allWordsArePersonal(snapshot, access));
  const listIsEmpty = listRows.length === 0;
  const openScope = singleList
    ? snapshot?.meta?.scopes.find(
        (scope) =>
          scope.space_id === (openList === "workspace" ? null : openList.slice("space:".length))
      )
    : undefined;
  // Hidden words still belong to the list, so it only counts as empty with none at all.
  const openListHasEntries =
    openScope !== undefined &&
    (snapshot?.entries ?? []).some((entry) => entry.spaceId === openScope.space_id);
  const readOnlyTarget: AddTargetOption | null =
    readOnlyList && openScope
      ? { target: openScope.space_id, label: openEntry?.label ?? "" }
      : null;
  const headerDetail = openScope
    ? t("dictionary.shared.memberCount", { count: openScope.member_count })
    : String(rows.length);

  // The dialog animates out after the request clears, so it keeps showing the last title.
  const lastDeleteTitle = useRef("");
  if (actions.deleteTitle !== null) lastDeleteTitle.current = actions.deleteTitle;

  const emptyPersonalState = (
    <div className="flex min-h-64 items-start px-6 py-6">
      <div className="relative z-10 w-full min-w-0 md:w-3/5">
        <h2 className="text-xl font-normal text-foreground">{t("dictionary.emptyTitle")}</h2>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-foreground/50 dark:text-foreground/65">
          {t("dictionary.emptyDescription", { agentName })}
        </p>
        <Button className="mt-6 px-5 font-normal" onClick={() => addInputRef.current?.focus()}>
          <Plus size={16} />
          {t("dictionary.addFirstWord")}
        </Button>
      </div>
      <DictionaryEmptyIllustration variant="dictionary" />
    </div>
  );

  const importIntoOpenList = (): void => {
    if (openScope) setPickedTarget({ list: openList, target: openScope.space_id, workspaceId });
    setShowBulkImport(true);
  };

  const listCard =
    !locked && singleList && listIsEmpty && openScope && !openListHasEntries ? (
      <SharedListEmpty
        listName={openEntry?.label ?? ""}
        memberCount={openScope.member_count}
        onImport={importIntoOpenList}
        onShareFromPersonal={() => {
          selectList("personal");
          setSelectModeList("personal");
        }}
      />
    ) : personalView && listIsEmpty ? (
      <div
        className={cn(
          CARD_SURFACE_CLASS,
          "relative overflow-hidden rounded-3xl shadow-sm dark:bg-surface-window"
        )}
      >
        {emptyPersonalState}
      </div>
    ) : (
      <div
        className={cn(
          CARD_SURFACE_CLASS,
          "rounded-lg px-4 py-3 shadow-sm",
          readOnlyList && "opacity-60"
        )}
        style={selectionActive ? { paddingBottom: selectionBarClearance } : undefined}
      >
        <div className="flex items-center justify-between gap-3 border-b border-dashed border-foreground/10 pb-2 dark:border-white/10">
          <h3 dir="auto" className="truncate text-[11px] font-semibold text-foreground/45">
            {openEntry?.label} · {headerDetail}
          </h3>
          <div className="flex shrink-0 items-center gap-3">
            {personalOnlyList && visiblePersonal.length > 0 && (
              <>
                <button
                  onClick={() => setConfirmClear(true)}
                  aria-label={t("dictionary.clearAll")}
                  className="text-[11px] text-foreground/45 transition-colors hover:text-destructive/70"
                >
                  {t("dictionary.clearAll")}
                </button>
                <button
                  onClick={() => void actions.exportPersonal()}
                  aria-label={t("dictionary.exportDictionary")}
                  className="text-foreground/45 transition-colors hover:text-foreground/60"
                >
                  <Download size={12} />
                </button>
              </>
            )}
            <span className="text-[10px] text-foreground/40">{t(SORT_LABEL_KEYS[sort])}</span>
          </div>
        </div>
        {rows.length === 0 ? (
          <p dir="auto" className="py-6 text-center text-xs text-foreground/45">
            {!listIsEmpty
              ? t("dictionary.shared.noMatches", { query: search.trim() })
              : openListHasEntries
                ? t("dictionary.shared.allHiddenList", { list: openEntry?.label ?? "" })
                : t("dictionary.shared.emptyList", { list: openEntry?.label ?? "" })}
          </p>
        ) : (
          <DictionaryWordList
            rows={rows}
            hiddenList={openList === "hidden"}
            onEdit={actions.editRow}
            onDelete={(row) => actions.deletePersonalWords([row.word])}
            onHide={(row) => void actions.hideRow(row)}
            onUnhide={(row) => void actions.setRowsHidden([row], false)}
            onDeleteForEveryone={(row) => actions.requestDeleteForEveryone([row])}
            onShare={
              canShare ? (row, anchor) => setShareRequest({ words: [row.word], anchor }) : undefined
            }
            selection={wordListSelection}
            readOnly={readOnlyList}
            getScrollElement={getScrollElement}
          />
        )}
      </div>
    );

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex flex-col h-full">
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t("dictionary.clearTitle")}
        description={t("dictionary.clearDescription")}
        confirmText={t("dictionary.clearAll")}
        cancelText={t("common.cancel")}
        onConfirm={actions.clearPersonal}
        variant="destructive"
      />
      <ConfirmDialog
        open={actions.deleteTitle !== null}
        onOpenChange={(open) => {
          if (!open) actions.cancelDelete();
        }}
        title={actions.deleteTitle ?? lastDeleteTitle.current}
        confirmText={t("dictionary.shared.actions.deleteForEveryone")}
        cancelText={t("common.cancel")}
        onConfirm={actions.confirmDelete}
        variant="destructive"
      />

      <ShareWordsPopover
        open={shareRequest !== null}
        onOpenChange={(open) => {
          if (!open) setShareRequest(null);
        }}
        anchor={shareRequest?.anchor ?? null}
        words={shareRequest?.words ?? []}
        targets={shareOptions}
        onShare={shareRequested}
      />

      <div
        className={cn(
          PAGE_CONTENT_WIDTH_CLASS,
          "flex items-center justify-between gap-3 px-6 pt-6"
        )}
      >
        <TabsList variant="pill">
          <TabsTrigger value="dictionary" variant="pill">
            <NotebookPen size={17} />
            {t("dictionary.tabDictionary")}
          </TabsTrigger>
          <TabsTrigger value="snippets" variant="pill">
            <PanelRight size={17} />
            {t("dictionary.tabSnippets")}
          </TabsTrigger>
        </TabsList>
        {tab === "dictionary" && (
          <DictionaryToolbar
            search={search}
            onSearchChange={setSearch}
            sort={sort}
            onSortChange={(next) => {
              setSort(next);
              writeStorage(SORT_STORAGE_KEY, next);
            }}
            showSync={isSignedIn}
            syncing={storeSyncing || actions.syncing}
            lastSyncedAt={lastSyncedAt}
            onSync={() => void actions.sync()}
          />
        )}
      </div>

      <TabsContent
        ref={scrollRef}
        value="dictionary"
        className="flex-1 min-h-0 mt-0 overflow-y-auto"
      >
        <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "flex gap-5 px-6 py-5")}>
          {pickerShown && (
            <DictionaryListPicker
              entries={pickerEntries}
              selected={openList}
              onSelect={selectList}
            />
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {lockedAccess && !readOnlyList ? (
              <SharedDictionaryLocked
                access={lockedAccess}
                workspaceName={workspaceName}
                scopes={scopes}
                canManage={canManage}
                onUpgrade={onUpgrade}
              />
            ) : (
              <>
                {lockedAccess && (
                  <SharedDictionaryUpsell
                    access={lockedAccess}
                    workspaceName={workspaceName}
                    scopes={scopes}
                    canManage={canManage}
                    onUpgrade={onUpgrade}
                  />
                )}
                <DictionaryAddField
                  // A read-only list's field names that list, though nothing can be added to it.
                  target={readOnlyTarget ? readOnlyTarget.target : addTarget}
                  targets={readOnlyTarget ? [readOnlyTarget] : addTargets}
                  disabled={readOnlyList}
                  onTargetChange={(target) => {
                    setPickedTarget({ list: openList, target, workspaceId });
                    rememberTarget(target);
                  }}
                  onAdd={addWords}
                  isInTarget={(word) =>
                    actions.wordsInTarget(addTarget).some((existing) => sameWord(existing, word))
                  }
                  isHiddenInTarget={(word) => actions.isHiddenInTarget(addTarget, word)}
                  onUnhide={(word) => actions.unhideInTarget(addTarget, word)}
                  onImport={() => setShowBulkImport(true)}
                  inputRef={addInputRef}
                />

                {/* ─── Bulk import ─── */}
                {showBulkImport && !readOnlyList && (
                  <div className="rounded-md border border-primary/30 dark:border-primary/40 px-3 pt-2.5 pb-2">
                    <Textarea
                      dir="auto"
                      autoFocus
                      value={bulkText}
                      onChange={(e) => setBulkText(e.target.value)}
                      placeholder={t("dictionary.importPlaceholder")}
                      rows={4}
                      className="min-h-[72px] resize-none border-0 shadow-none rounded-none bg-transparent p-0 text-xs text-foreground placeholder:text-foreground/45 hover:border-0 focus:border-0 focus:ring-0"
                    />
                    <div className="flex items-center justify-between pt-1.5">
                      <p className="text-xs text-foreground/45">
                        {t("dictionary.separateWithCommas")}
                        {pendingImportCount > 0 && (
                          <span className="text-success">
                            {" • "}
                            {t("dictionary.wordsReady", { count: pendingImportCount })}
                          </span>
                        )}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setBulkText("");
                            setShowBulkImport(false);
                          }}
                        >
                          {t("common.cancel")}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void handleImport()}
                          disabled={pendingImportCount === 0 || importing}
                        >
                          {t("dictionary.shared.importTo", { list: listLabel(addTarget) })}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ─── Agent name (always recognized) ─── */}
                {personalView && !listIsEmpty && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/15 bg-primary/3 px-4 py-2.5 dark:border-primary/20 dark:bg-primary/6">
                    <div className="flex items-center gap-2 min-w-0">
                      <Sparkles size={11} className="text-primary/70 shrink-0" />
                      <span dir="auto" className="text-xs font-medium text-primary truncate">
                        {agentName}
                      </span>
                    </div>
                    <span className="text-xs text-foreground/45 shrink-0">
                      {t("dictionary.agentDefault")}
                    </span>
                  </div>
                )}

                {listCard}

                {selectionActive && (
                  <SelectionActionBar
                    count={selectedRows.length}
                    total={rows.length}
                    allShownSelected={selection.allShownSelected}
                    onSelectAll={selection.selectAll}
                    onClear={clearSelection}
                    onDelete={selectedPersonal.length > 0 ? deleteSelectedPersonal : undefined}
                    onShare={
                      canShare && selectedPersonal.length > 0
                        ? (anchor) =>
                            setShareRequest((current) =>
                              current
                                ? null
                                : { words: selectedPersonal.map((row) => row.word), anchor }
                            )
                        : undefined
                    }
                    shareOpen={shareRequest !== null}
                    onHide={selectedShared.length > 0 ? () => void hideSelected() : undefined}
                    hideBusy={hidingSelected}
                    onClearanceChange={setSelectionBarClearance}
                    onDeleteForEveryone={
                      selectedShared.length > 0
                        ? () => actions.requestDeleteForEveryone(selectedShared, clearSelection)
                        : undefined
                    }
                  />
                )}
              </>
            )}

            {/* ─── Provider prompt-limit notice ─── */}
            {promptChars > WHISPER_DECODER_PROMPT_CHARS && (
              <p className="text-xs text-foreground/45 leading-relaxed">
                {t("dictionary.promptLimitNotice", { chars: promptChars })}
              </p>
            )}
          </div>
        </div>
      </TabsContent>

      <TabsContent value="snippets" className="flex-1 min-h-0 mt-0 overflow-y-auto">
        <SnippetsView />
      </TabsContent>
    </Tabs>
  );
}

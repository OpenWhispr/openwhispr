import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast, type ToastActionConfig } from "../ui/useToast";
import {
  SharedDictionaryActionError,
  addSharedWords,
  deleteSharedWords,
  editSharedWord,
  setSharedWordsHidden,
  sharePersonalWords,
  type ShareTarget,
  type SharedDictionaryActionReason,
} from "../../services/sharedDictionaryActions";
import { syncService } from "../../services/SyncService";
import { useSharedDictionaryStore } from "../../stores/sharedDictionaryStore";
import { parseDictionaryImportText } from "../../helpers/dictionaryImport";
import logger from "../../utils/logger";
import { isTermLikeSharedWord } from "../../utils/sharedDictionaryHints";
import { dictionaryWordKey } from "../../utils/snippets";
import type { SharedDictionarySnapshot } from "../../types/sharedDictionary";
import type { AddTarget } from "./DictionaryAddField";
import {
  listsShowingWord,
  shownPersonalWords,
  type DictionaryRow,
  type SharedAccessState,
} from "./dictionaryViewModel";

interface DictionaryActionsInput {
  workspaceId: string | null;
  workspaceName: string;
  customDictionary: string[];
  // The personal words minus the agent name, as the Personal list shows them.
  userWords: string[];
  agentName: string;
  updateCustomDictionary: (changes: { add?: string[]; remove?: string[] }) => void;
  movedPersonal: string[];
  snapshot: SharedDictionarySnapshot | null;
  access: SharedAccessState;
  listLabel: (target: AddTarget) => string;
}

interface PendingSharedDelete {
  // The workspace the words were picked in; the delete never runs in another one.
  workspaceId: string;
  entryIds: string[];
  words: string[];
  listName: string;
  onDeleted?: () => void;
}

// Why an edit didn't save. A refusal can't succeed as typed, so leaving the
// editor drops it; anything else keeps the typed text for another try.
export interface EditFailure {
  message: string;
  refused: boolean;
}

interface ShareFailure {
  count: number;
  reason: SharedDictionaryActionReason;
  // Only set for listFull when the full list is known.
  target?: ShareTarget;
}

type PartialKind = "add" | "hide" | "unhide" | "delete";

export interface DictionaryActions {
  // Personal words the member can see; clear-all removes exactly these.
  visiblePersonal: string[];
  wordsInTarget: (target: AddTarget) => string[];
  // Whether a typed word is in a shared list only as a copy the member hid,
  // which the list doesn't show them.
  isHiddenInTarget: (target: AddTarget, word: string) => boolean;
  // Unhides that copy; resolves true once it's back.
  unhideInTarget: (target: AddTarget, word: string) => Promise<boolean>;
  // Resolves true once nothing is left to add, which clears the field.
  addWords: (text: string, target: AddTarget) => Promise<boolean>;
  // Resolves why the edit failed, to show in the open editor, or null to close it.
  editRow: (row: DictionaryRow, word: string) => Promise<EditFailure | null>;
  // Resolves true once every row changed.
  setRowsHidden: (rows: DictionaryRow[], hidden: boolean) => Promise<boolean>;
  // Hides one row's word, with an Undo toast.
  hideRow: (row: DictionaryRow) => Promise<void>;
  // Delete for everyone always asks first; the dialog reads `deleteTitle`.
  // onDeleted runs once the confirmed delete fully succeeded.
  requestDeleteForEveryone: (rows: DictionaryRow[], onDeleted?: () => void) => void;
  // Moves personal words into the lists; resolves true when all of them went.
  shareWords: (words: string[], targets: ShareTarget[]) => Promise<boolean>;
  // Removes personal words; several at once come with an Undo toast.
  deletePersonalWords: (words: string[]) => void;
  deleteTitle: string | null;
  confirmDelete: () => void;
  cancelDelete: () => void;
  syncing: boolean;
  sync: () => Promise<void>;
  exportPersonal: () => Promise<void>;
  clearPersonal: () => void;
}

// How many left-out words a toast names before it only counts the rest.
const SKIPPED_NAMES_SHOWN = 3;
// As long as the app's other Undo toasts stay up.
const UNDO_TOAST_MS = 6000;

const sameWord = (left: string, right: string): boolean =>
  dictionaryWordKey(left) === dictionaryWordKey(right);
const reasonOf = (error: unknown): SharedDictionaryActionReason =>
  error instanceof SharedDictionaryActionError ? error.reason : "network";
// How many entries a batched delete or hide changed before it failed.
const appliedCountOf = (error: unknown): number =>
  error instanceof SharedDictionaryActionError ? error.appliedCount : 0;

export function useDictionaryActions({
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
}: DictionaryActionsInput): DictionaryActions {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingSharedDelete | null>(null);

  // A confirm dialog left open across a workspace switch would name words the
  // new workspace doesn't have, so the switch withdraws it.
  useEffect(() => {
    setPendingDelete((pending) =>
      pending && pending.workspaceId !== workspaceId ? null : pending
    );
  }, [workspaceId]);

  // Ruling 4: while shared words apply, clear-all and export leave out words
  // moved into a team list, which stay under the shared copy as the member's fallback.
  const visiblePersonal = useMemo(
    () => shownPersonalWords(userWords, movedPersonal, snapshot, access),
    [userWords, movedPersonal, snapshot, access]
  );

  // Re-adding a moved word makes it personal again in SQLite; the stored list
  // arrives after that write, so reread which words are still moved.
  const seenDictionary = useRef(customDictionary);
  useEffect(() => {
    if (seenDictionary.current === customDictionary) return;
    seenDictionary.current = customDictionary;
    const store = useSharedDictionaryStore.getState();
    if (store.movedPersonal.length > 0) void store.reload();
  }, [customDictionary]);

  // Only a network failure is worth trying again; every other reason names its fix.
  const errorTitle = useCallback(
    (reason: SharedDictionaryActionReason, listName: string): string => {
      switch (reason) {
        case "listFull":
        case "planRequired":
        case "ssoRequired":
        case "notMember":
        case "invalid":
        case "recentlyDeleted":
          return t(`dictionary.shared.errors.${reason}`, { list: listName });
        case "alreadyInList":
          return t("dictionary.shared.alreadyIn", { list: listName });
        case "personalChanged":
          return t("dictionary.shared.share.reasons.personalChanged");
        default:
          return t("dictionary.shared.errors.generic", { list: listName });
      }
    },
    [t]
  );

  const showActionError = useCallback(
    (reason: SharedDictionaryActionReason, listName: string): void => {
      toast({ title: errorTitle(reason, listName), variant: "destructive" });
    },
    [toast, errorTitle]
  );

  const wordsInTarget = (target: AddTarget): string[] => {
    // A moved word the member can't see in Personal can be added back to it.
    if (target === "personal") return [...visiblePersonal, agentName];
    // A hidden word still belongs to its list, so the server would refuse it too.
    return (snapshot?.entries ?? [])
      .filter((entry) => entry.spaceId === target)
      .map((entry) => entry.word);
  };

  const hiddenCopiesIn = (target: AddTarget, word: string): string[] => {
    if (target === "personal" || !snapshot) return [];
    const hidden = new Set(snapshot.hiddenIds);
    return snapshot.entries
      .filter(
        (entry) =>
          entry.spaceId === target && hidden.has(entry.cloudId) && sameWord(entry.word, word)
      )
      .map((entry) => entry.cloudId);
  };

  const listNameOf = (entryId: string | null): string => {
    const spaceId = snapshot?.entries.find((entry) => entry.cloudId === entryId)?.spaceId;
    return spaceId === undefined ? workspaceName : listLabel(spaceId);
  };
  // Every list a row's copies are in: All words shows a word in several lists once.
  const rowListNames = (row: DictionaryRow): string[] => row.entryIds.map(listNameOf);
  // A teammate's dictation would leave these out, so they never go to a shared list.
  const notTermLike = (words: string[]): boolean =>
    words.some((word) => !isTermLikeSharedWord(word));
  const splitShareable = (words: string[]): { shareable: string[]; skipped: string[] } => ({
    shareable: words.filter(isTermLikeSharedWord),
    skipped: words.filter((word) => !isTermLikeSharedWord(word)),
  });
  // Names the first few words left out and counts them all.
  const reportSkipped = (skipped: string[], nothingSent: boolean): void => {
    if (skipped.length === 0) return;
    const named = skipped.slice(0, SKIPPED_NAMES_SHOWN).join(", ");
    toast({
      title: t("dictionary.shared.skipped", {
        count: skipped.length,
        words: skipped.length > SKIPPED_NAMES_SHOWN ? `${named}, …` : named,
      }),
      description: t("dictionary.shared.notTermLike"),
      variant: nothingSent ? "destructive" : "default",
    });
  };

  // A selection in All shared can span lists; name each of them once.
  const listNames = (names: string[]): string =>
    new Intl.ListFormat(i18n.language, { type: "conjunction" }).format([...new Set(names)]);

  const failureLine = (
    reason: SharedDictionaryActionReason,
    targetNames: string,
    target?: ShareTarget
  ): string => {
    if (reason === "listFull") {
      return target === undefined
        ? t("dictionary.shared.share.reasons.aListFull")
        : t("dictionary.shared.errors.listFull", { list: listLabel(target) });
    }
    if (reason === "network") return t("dictionary.shared.share.reasons.network");
    return errorTitle(reason, targetNames);
  };

  // A batch that stopped part-way says how much went through; one that changed
  // nothing reads as the plain failure.
  const reportPartial = (
    kind: PartialKind,
    applied: number,
    notApplied: number,
    failure: { reason: SharedDictionaryActionReason; listName: string; target?: ShareTarget },
    actions?: ToastActionConfig[]
  ): void => {
    toast({
      title:
        applied === 0
          ? errorTitle(failure.reason, failure.listName)
          : t(`dictionary.shared.partial.${kind}`, {
              applied,
              total: applied + notApplied,
              count: notApplied,
              list: failure.listName,
            }),
      description:
        applied === 0 ? undefined : failureLine(failure.reason, failure.listName, failure.target),
      variant: "destructive",
      duration: actions ? UNDO_TOAST_MS : undefined,
      actions,
    });
  };

  // All words shows the shared copy in the personal word's place, which would
  // otherwise look like the delete or rename didn't happen.
  const reportStillShared = (word: string): void => {
    const lists = listsShowingWord(word, snapshot, access);
    if (lists.length === 0) return;
    toast({
      title: t("dictionary.shared.stillIn", { word, list: listNames(lists.map(listLabel)) }),
    });
  };

  const addWords = async (text: string, target: AddTarget): Promise<boolean> => {
    const existing = new Set(wordsInTarget(target).map(dictionaryWordKey));
    const words = parseDictionaryImportText(text).filter((word) => {
      const key = dictionaryWordKey(word);
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });
    if (words.length === 0) return true;
    if (target === "personal") {
      updateCustomDictionary({ add: words });
      return true;
    }
    if (!workspaceId) return false;
    const { shareable, skipped } = splitShareable(words);
    if (shareable.length === 0) {
      reportSkipped(skipped, true);
      return false;
    }
    const result = await addSharedWords(workspaceId, target, shareable);
    if (result.failed) {
      reportSkipped(skipped, result.added.length === 0);
      reportPartial("add", result.added.length, result.failed.words.length, {
        reason: result.failed.reason,
        listName: listLabel(target),
        target,
      });
      return false;
    }
    // The rest went in, so the field clears; the toast names what was left out.
    reportSkipped(skipped, false);
    return true;
  };

  const editRow = async (row: DictionaryRow, word: string): Promise<EditFailure | null> => {
    if (word === row.word) return null;
    if (row.kind === "personal") {
      // Like the add field: a word hidden under a shared copy doesn't block the
      // rename, which makes it personal again.
      const taken = wordsInTarget("personal");
      if (taken.some((other) => other !== row.word && sameWord(other, word))) {
        return {
          message: t("dictionary.shared.alreadyIn", { list: t("dictionary.shared.personal") }),
          refused: true,
        };
      }
      updateCustomDictionary({ add: [word], remove: [row.word] });
      // A change of case keeps the personal word in front of the shared copy.
      if (!sameWord(word, row.word)) reportStillShared(row.word);
      return null;
    }
    if (!workspaceId || row.entryIds.length === 0) return null;
    if (notTermLike([word])) return { message: t("dictionary.shared.notTermLike"), refused: true };
    // All words shows a word in several lists once, so the rename goes to every
    // copy; renaming one would leave the old spelling beside the new one. A copy
    // that fails doesn't stop the others, and the first failure is the one shown.
    let failure: EditFailure | null = null;
    for (const entryId of row.entryIds) {
      try {
        await editSharedWord(workspaceId, entryId, word);
      } catch (error) {
        const reason = reasonOf(error);
        failure ??= {
          message: errorTitle(reason, listNameOf(entryId)),
          refused: reason !== "network",
        };
      }
    }
    return failure;
  };

  const entryIdsOf = (rows: DictionaryRow[]): string[] => rows.flatMap((row) => row.entryIds);

  const setEntriesHidden = async (
    entryIds: string[],
    hidden: boolean,
    listName: () => string
  ): Promise<boolean> => {
    if (!workspaceId || entryIds.length === 0) return false;
    try {
      await setSharedWordsHidden(workspaceId, entryIds, hidden);
      return true;
    } catch (error) {
      const applied = appliedCountOf(error);
      reportPartial(hidden ? "hide" : "unhide", applied, new Set(entryIds).size - applied, {
        reason: reasonOf(error),
        listName: listName(),
      });
      return false;
    }
  };

  const setRowsHidden = (rows: DictionaryRow[], hidden: boolean): Promise<boolean> => {
    const shared = rows.filter((row) => row.entryIds.length > 0);
    return setEntriesHidden(entryIdsOf(shared), hidden, () =>
      listNames(shared.flatMap(rowListNames))
    );
  };

  const hideRow = async (row: DictionaryRow): Promise<void> => {
    if (!(await setRowsHidden([row], true))) return;
    toast({
      title: t("dictionary.shared.hiddenWord", { word: row.word }),
      duration: UNDO_TOAST_MS,
      actions: [
        {
          label: t("dictionary.shared.undo"),
          onClick: async () => {
            await setRowsHidden([row], false);
          },
        },
      ],
    });
  };

  const unhideInTarget = (target: AddTarget, word: string): Promise<boolean> =>
    setEntriesHidden(hiddenCopiesIn(target, word), false, () => listLabel(target));

  const requestDeleteForEveryone = (rows: DictionaryRow[], onDeleted?: () => void): void => {
    const shared = rows.filter((row) => row.entryIds.length > 0);
    if (!workspaceId || shared.length === 0) return;
    setPendingDelete({
      workspaceId,
      entryIds: entryIdsOf(shared),
      words: shared.map((row) => row.word),
      listName: listNames(shared.flatMap(rowListNames)),
      onDeleted,
    });
  };

  const shareWords = async (words: string[], targets: ShareTarget[]): Promise<boolean> => {
    if (!workspaceId || words.length === 0 || targets.length === 0) return false;
    const targetNames = listNames(targets.map(listLabel));
    // Words left out stay personal (and selected), so the share reports false.
    const { shareable, skipped } = splitShareable(words);
    if (shareable.length === 0) {
      reportSkipped(skipped, true);
      return false;
    }
    let moved = 0;
    let failed: ShareFailure | null;
    try {
      const result = await sharePersonalWords(workspaceId, targets, shareable);
      moved = result.moved.length;
      failed = result.failed
        ? {
            count: result.failed.words.length,
            reason: result.failed.reason,
            target: result.failed.target,
          }
        : null;
    } catch (error) {
      failed = { count: shareable.length, reason: reasonOf(error) };
    }
    reportSkipped(skipped, moved === 0 && failed !== null);
    if (!failed) return skipped.length === 0;
    if (moved === 0) {
      // Nothing went, so the reason alone says what happened.
      toast({
        title:
          failed.reason === "network"
            ? t("dictionary.shared.errors.generic", { list: targetNames })
            : failureLine(failed.reason, targetNames, failed.target),
        variant: "destructive",
      });
      return false;
    }
    toast({
      // Plural on the words that weren't shared: "1 wasn't" / "2 weren't".
      title: t("dictionary.shared.share.partial", {
        moved,
        total: moved + failed.count,
        count: failed.count,
      }),
      description: failureLine(failed.reason, targetNames, failed.target),
      variant: "destructive",
    });
    return false;
  };

  const deletePersonalWords = (words: string[]): void => {
    if (words.length === 0) return;
    updateCustomDictionary({ remove: words });
    // One word goes as it always has; a bulk delete can be taken back.
    if (words.length < 2) {
      reportStillShared(words[0]);
      return;
    }
    toast({
      title: t("dictionary.shared.deletedPersonalMany", { count: words.length }),
      duration: UNDO_TOAST_MS,
      actions: [
        {
          label: t("dictionary.shared.undo"),
          onClick: () => updateCustomDictionary({ add: words }),
        },
      ],
    });
  };

  const undoAction = (
    undo: () => Promise<void>,
    listName: string
  ): { label: string; onClick: () => Promise<void> } => ({
    label: t("dictionary.shared.undo"),
    onClick: async (): Promise<void> => {
      try {
        await undo();
      } catch (error) {
        showActionError(reasonOf(error), listName);
      }
    },
  });

  const runDelete = async ({
    workspaceId: deleteWorkspaceId,
    entryIds,
    words,
    listName,
    onDeleted,
  }: PendingSharedDelete): Promise<void> => {
    try {
      const { undo } = await deleteSharedWords(deleteWorkspaceId, entryIds);
      onDeleted?.();
      toast({
        title:
          words.length === 1
            ? t("dictionary.shared.deletedForEveryone", { word: words[0] })
            : t("dictionary.shared.deletedManyForEveryone", { count: words.length }),
        duration: UNDO_TOAST_MS,
        actions: [undoAction(undo, listName)],
      });
    } catch (error) {
      // A batch that failed part-way can still restore what it deleted.
      const partialUndo = error instanceof SharedDictionaryActionError ? error.undo : undefined;
      const applied = appliedCountOf(error);
      reportPartial(
        "delete",
        applied,
        new Set(entryIds).size - applied,
        { reason: reasonOf(error), listName },
        partialUndo ? [undoAction(partialUndo, listName)] : undefined
      );
    }
  };

  // Read through the workspace check, so the render that switches workspaces
  // already shows no dialog, before the effect above clears it.
  const liveDelete = pendingDelete?.workspaceId === workspaceId ? pendingDelete : null;
  const deleteTitle = liveDelete
    ? liveDelete.words.length === 1
      ? t("dictionary.shared.deleteOneTitle", {
          word: liveDelete.words[0],
          list: liveDelete.listName,
        })
      : t("dictionary.shared.deleteManyTitle", {
          count: liveDelete.words.length,
          list: liveDelete.listName,
        })
    : null;

  const confirmDelete = (): void => {
    if (!liveDelete) return;
    const request = liveDelete;
    setPendingDelete(null);
    void runDelete(request);
  };

  const sync = async (): Promise<void> => {
    setSyncing(true);
    const { generation } = useSharedDictionaryStore.getState();
    let failed = false;
    // The toolbar fires this without awaiting it, so a failure must not escape.
    const logFailure = (error: unknown): void => {
      failed = true;
      logger.warn("Dictionary sync failed", { error: (error as Error)?.message }, "dictionary");
    };
    try {
      await Promise.all([
        syncService.syncSharedDictionaryNow().catch(logFailure),
        syncService.syncDictionaryNow().catch(logFailure),
      ]);
      if (!failed) useSharedDictionaryStore.getState().markSynced(generation);
    } finally {
      setSyncing(false);
    }
  };

  const exportPersonal = async (): Promise<void> => {
    // The export keeps the agent name, as it always has.
    const words = shownPersonalWords(customDictionary, movedPersonal, snapshot, access);
    const result = await window.electronAPI?.exportDictionary?.(words);
    if (result?.error) {
      toast({
        title: t("dictionary.exportFailed"),
        description: result.error,
        variant: "destructive",
      });
    }
  };

  return {
    visiblePersonal,
    wordsInTarget,
    isHiddenInTarget: (target, word) => hiddenCopiesIn(target, word).length > 0,
    unhideInTarget,
    addWords,
    editRow,
    setRowsHidden,
    hideRow,
    requestDeleteForEveryone,
    shareWords,
    deletePersonalWords,
    deleteTitle,
    confirmDelete,
    cancelDelete: () => setPendingDelete(null),
    syncing,
    sync,
    exportPersonal,
    clearPersonal: () => updateCustomDictionary({ remove: visiblePersonal }),
  };
}

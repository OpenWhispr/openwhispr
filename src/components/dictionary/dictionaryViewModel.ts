import type { TFunction } from "i18next";
import type { ListKey, SharedDictionaryStatus } from "../../stores/sharedDictionaryStore";
import type { ShareTarget } from "../../services/sharedDictionaryActions";
import type { Workspace } from "../../types/electron";
import type {
  SharedDictionarySnapshot,
  SharedDictionarySnapshotEntry,
} from "../../types/sharedDictionary";
import { hasSharedDictionaryPlan } from "../../lib/workspaceBilling";
import { canManageWorkspace } from "../../lib/spacePermissions";
import { isTermLikeSharedWord } from "../../utils/sharedDictionaryHints";
import { dictionaryWordKey } from "../../utils/snippets";

export type SortKey = "az" | "za" | "newest" | "oldest";

export const SORT_LABEL_KEYS: Record<SortKey, string> = {
  az: "dictionary.shared.sort.az",
  za: "dictionary.shared.sort.za",
  newest: "dictionary.shared.sort.newest",
  oldest: "dictionary.shared.sort.oldest",
};

export type SharedAccessState =
  | "unavailable"
  | "noWorkspace"
  | "ssoRequired"
  | "noAccess"
  | "upgradeAdmin"
  | "upgradeMember"
  | "paused"
  | "available";

export interface PickerEntry {
  key: ListKey;
  label: string;
  // null while the shared lists haven't been read yet.
  count: number | null;
  locked: boolean;
  group: "top" | "shared" | "bottom";
}

export interface DictionaryRow {
  key: string;
  word: string;
  kind: "personal" | "shared";
  // The entry an edit renames: for a word in several lists, the copy dictation ranks first.
  entryId: string | null;
  // Every shared copy the row stands for. All words lists a word once, so
  // hiding or deleting it there acts on each copy rather than revealing the next.
  entryIds: string[];
  // The list a shared row belongs to, shown where a list mixes several.
  badge: string | null;
  // How many more lists hold the word, shown as "+n" beside the badge.
  otherLists: number;
  attribution: "you" | "former" | { name: string } | null;
  createdAt: string | null;
  // A personal word's place in the dictionary, which keeps the order words were added.
  addedIndex: number | null;
  // False for a shared word dictation leaves out (see isTermLikeSharedWord).
  usedInDictation: boolean;
}

type Snapshot = SharedDictionarySnapshot | null;

interface RowsInput {
  personal: string[];
  movedPersonal: string[];
  snapshot: Snapshot;
  workspaceName: string;
  currentUserId: string | null;
  access: SharedAccessState;
  search: string;
  sort: SortKey;
}

interface SharedRowOptions {
  badge: boolean;
  attribution: boolean;
}

// The key dictation dedupes by, so a list never shows two rows dictation treats as one word.
const wordKey = dictionaryWordKey;

export function resolveSharedAccessState(input: {
  status: SharedDictionaryStatus;
  // False in a build without an account backend too, where no one can sign in.
  signedIn: boolean;
  workspace: Workspace | null;
  // The server's flag. It is set on every answer for a workspace without the
  // plan, so it only means "paused" when there are words to pause.
  serverPaused: boolean | null;
  hasWords: boolean;
}): SharedAccessState {
  const { status, signedIn, workspace, serverPaused, hasWords } = input;
  // Signed out there is no workspace to share with, so nothing to offer either.
  if (status === "unavailable" || !signedIn) return "unavailable";
  if (!workspace) return "noWorkspace";
  // Neither can be fixed from a plan, so they come before the plan checks.
  if (status === "ssoRequired") return "ssoRequired";
  if (status === "noAccess") return "noAccess";
  if (serverPaused === true && hasWords) return "paused";
  if (!hasSharedDictionaryPlan(workspace)) {
    return canManageWorkspace(workspace.role) ? "upgradeAdmin" : "upgradeMember";
  }
  return "available";
}

// Entries of lists the member can still read. The snapshot is replaced when the
// readable lists change, so the filter only guards the window before that.
function readableEntries(snapshot: Snapshot): SharedDictionarySnapshotEntry[] {
  if (!snapshot) return [];
  const scopes = snapshot.meta?.scopes;
  if (!scopes) return snapshot.entries;
  const readable = new Set(scopes.map((scope) => scope.space_id));
  return snapshot.entries.filter((entry) => readable.has(entry.spaceId));
}

function visibleSharedEntries(snapshot: Snapshot): SharedDictionarySnapshotEntry[] {
  if (!snapshot) return [];
  const hidden = new Set(snapshot.hiddenIds);
  return readableEntries(snapshot).filter((entry) => !hidden.has(entry.cloudId));
}

function hiddenSharedEntries(snapshot: Snapshot): SharedDictionarySnapshotEntry[] {
  if (!snapshot) return [];
  const hidden = new Set(snapshot.hiddenIds);
  return readableEntries(snapshot).filter((entry) => hidden.has(entry.cloudId));
}

/**
 * Personal words minus those moved into a team list while that shared copy
 * still exists. The personal row is kept underneath as a fallback, so if the
 * copy is deleted the word returns to Personal. A hidden copy still counts:
 * the server retires the fallback when a member hides the shared word.
 */
export function visiblePersonalWords(
  personal: string[],
  movedPersonal: string[],
  snapshot: Snapshot
): string[] {
  if (movedPersonal.length === 0 || !snapshot) return personal;
  const moved = new Set(movedPersonal.map(wordKey));
  const sharedWords = new Set(readableEntries(snapshot).map((entry) => wordKey(entry.word)));
  return personal.filter((word) => {
    const key = wordKey(word);
    return !(moved.has(key) && sharedWords.has(key));
  });
}

// The personal words Personal lists. While shared words don't apply (locked or
// paused), moved words keep applying at personal priority, so they show again;
// clear-all, export and the add field's "Already in" act on the same words.
export function shownPersonalWords(
  personal: string[],
  movedPersonal: string[],
  snapshot: Snapshot,
  access: SharedAccessState
): string[] {
  if (access !== "available") return personal;
  return visiblePersonalWords(personal, movedPersonal, snapshot);
}

// The lists whose copy of a word All words shows, while shared words apply.
export function listsShowingWord(
  word: string,
  snapshot: Snapshot,
  access: SharedAccessState
): Array<string | null> {
  if (access !== "available") return [];
  const key = wordKey(word);
  const lists = visibleSharedEntries(snapshot)
    .filter((entry) => wordKey(entry.word) === key)
    .map((entry) => entry.spaceId);
  return [...new Set(lists)];
}

// The workspace list's name; without a workspace name it reads as the locked panel does.
export function workspaceListLabel(workspaceName: string, t: TFunction): string {
  return workspaceName.trim()
    ? t("dictionary.shared.everyoneAt", { workspace: workspaceName })
    : t("dictionary.shared.locked.workspaceTitle");
}

function scopeName(snapshot: Snapshot, spaceId: string | null, workspaceName: string): string {
  if (spaceId === null) return workspaceName;
  const scope = snapshot?.meta?.scopes.find((candidate) => candidate.space_id === spaceId);
  return scope?.name ?? workspaceName;
}

function attributionFor(
  entry: SharedDictionarySnapshotEntry,
  snapshot: Snapshot,
  currentUserId: string | null
): DictionaryRow["attribution"] {
  if (entry.addedByUserId === null) return "former";
  if (currentUserId !== null && entry.addedByUserId === currentUserId) return "you";
  const contributor = snapshot?.meta?.contributors.find(
    (candidate) => candidate.user_id === entry.addedByUserId
  );
  // With no name to show (unknown or nameless contributor) the row reads as a former member.
  if (!contributor || !contributor.is_member || !contributor.name) return "former";
  return { name: contributor.name };
}

function sharedRow(
  entry: SharedDictionarySnapshotEntry,
  input: RowsInput,
  options: SharedRowOptions,
  // The other copies of the word this row stands for, in All words.
  others: SharedDictionarySnapshotEntry[] = []
): DictionaryRow {
  return {
    key: `shared:${entry.cloudId}`,
    word: entry.word,
    kind: "shared",
    entryId: entry.cloudId,
    entryIds: [entry.cloudId, ...others.map((other) => other.cloudId)],
    badge: options.badge ? scopeName(input.snapshot, entry.spaceId, input.workspaceName) : null,
    otherLists: options.badge ? new Set(others.map((other) => other.spaceId)).size : 0,
    attribution: options.attribution
      ? attributionFor(entry, input.snapshot, input.currentUserId)
      : null,
    createdAt: entry.createdAt,
    addedIndex: null,
    usedInDictation: isTermLikeSharedWord(entry.word),
  };
}

// Keyed by the exact spelling: case variants are separate personal words.
function personalRow(word: string, addedIndex: number): DictionaryRow {
  return {
    key: `personal:${word}`,
    word,
    kind: "personal",
    entryId: null,
    entryIds: [],
    badge: null,
    otherLists: 0,
    attribution: null,
    createdAt: null,
    addedIndex,
    usedInDictation: true,
  };
}

const personalWordsShown = (input: RowsInput): string[] =>
  shownPersonalWords(input.personal, input.movedPersonal, input.snapshot, input.access);

function personalRows(input: RowsInput): DictionaryRow[] {
  const order = new Map(input.personal.map((word, index) => [word, index]));
  return personalWordsShown(input).map((word) => personalRow(word, order.get(word) ?? 0));
}

// Space words rank above workspace words, as they do in dictation hints.
function spaceEntriesFirst(
  entries: SharedDictionarySnapshotEntry[]
): SharedDictionarySnapshotEntry[] {
  return [
    ...entries.filter((entry) => entry.spaceId !== null),
    ...entries.filter((entry) => entry.spaceId === null),
  ];
}

// Each word once, in the priority dictation uses: personal, then space, then workspace.
function allWordsRows(input: RowsInput): DictionaryRow[] {
  const seen = new Set<string>();
  const rows: DictionaryRow[] = [];
  for (const row of personalRows(input)) {
    const key = wordKey(row.word);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  // Shared words only join All words while they apply.
  if (input.access !== "available") return rows;
  const copies = new Map<string, SharedDictionarySnapshotEntry[]>();
  for (const entry of spaceEntriesFirst(visibleSharedEntries(input.snapshot))) {
    const key = wordKey(entry.word);
    if (seen.has(key)) continue;
    const list = copies.get(key);
    if (list) list.push(entry);
    else copies.set(key, [entry]);
  }
  for (const [first, ...others] of copies.values()) {
    rows.push(sharedRow(first, input, { badge: true, attribution: false }, others));
  }
  return rows;
}

// True while All words lists only personal words, so it shows what Personal does.
export function allWordsArePersonal(snapshot: Snapshot, access: SharedAccessState): boolean {
  return access !== "available" || visibleSharedEntries(snapshot).length === 0;
}

function unsortedRows(list: ListKey, input: RowsInput): DictionaryRow[] {
  const { snapshot } = input;
  const inSingleList = (spaceId: string | null): DictionaryRow[] =>
    visibleSharedEntries(snapshot)
      .filter((entry) => entry.spaceId === spaceId)
      .map((entry) => sharedRow(entry, input, { badge: false, attribution: true }));

  switch (list) {
    case "all":
      return allWordsRows(input);
    case "personal":
      return personalRows(input);
    case "allShared":
      // One row per list entry: the same word in two lists is two rows.
      return visibleSharedEntries(snapshot).map((entry) =>
        sharedRow(entry, input, { badge: true, attribution: false })
      );
    case "hidden":
      return hiddenSharedEntries(snapshot).map((entry) =>
        sharedRow(entry, input, { badge: true, attribution: true })
      );
    case "workspace":
      return inSingleList(null);
    default:
      return inSingleList(list.slice("space:".length));
  }
}

// One collator for every comparison: localeCompare builds one per call, which
// costs hundreds of milliseconds per keystroke on a large workspace.
const wordCollator = new Intl.Collator(undefined, { sensitivity: "base" });

function timestamp(row: DictionaryRow): number | null {
  if (!row.createdAt) return null;
  const parsed = Date.parse(row.createdAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Newest and oldest: shared words by the date they were added; personal words
 * have no date, so they follow the dated words in the order they were added to
 * the dictionary (the newest last added). Words without either come last, A–Z.
 */
function sortRows(rows: DictionaryRow[], sort: SortKey): DictionaryRow[] {
  const byWord = (left: DictionaryRow, right: DictionaryRow): number =>
    wordCollator.compare(left.word, right.word);
  if (sort === "az") return [...rows].sort(byWord);
  if (sort === "za") return [...rows].sort((left, right) => byWord(right, left));
  const direction = sort === "newest" ? -1 : 1;
  // Dates are parsed once per row rather than once per comparison.
  const decorated = rows.map((row) => ({ row, time: timestamp(row) }));
  const rank = (time: number | null, row: DictionaryRow): number =>
    time !== null ? 0 : row.addedIndex !== null ? 1 : 2;
  decorated.sort((left, right) => {
    const leftRank = rank(left.time, left.row);
    const rightRank = rank(right.time, right.row);
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (leftRank === 0 && left.time !== right.time) {
      return direction * ((left.time as number) - (right.time as number));
    }
    if (leftRank === 1) {
      return direction * ((left.row.addedIndex as number) - (right.row.addedIndex as number));
    }
    return byWord(left.row, right.row);
  });
  return decorated.map(({ row }) => row);
}

// A case-insensitive substring match; run over sorted rows, it keeps their order.
export function filterRows(rows: DictionaryRow[], search: string): DictionaryRow[] {
  const needle = search.trim().toLowerCase();
  return needle ? rows.filter((row) => row.word.toLowerCase().includes(needle)) : rows;
}

export function rowsForList(list: ListKey, input: RowsInput): DictionaryRow[] {
  return filterRows(sortRows(unsortedRows(list, input), input.sort), input.search);
}

export function buildPicker(input: {
  personal: string[];
  movedPersonal: string[];
  snapshot: Snapshot;
  workspaceName: string;
  access: SharedAccessState;
  t: TFunction;
}): PickerEntry[] {
  const { personal, movedPersonal, snapshot, workspaceName, access, t } = input;
  const locked = access !== "available";
  const visible = visibleSharedEntries(snapshot);
  const countIn = (spaceId: string | null): number | null =>
    snapshot ? visible.filter((entry) => entry.spaceId === spaceId).length : null;

  const rowsInput: RowsInput = {
    personal,
    movedPersonal,
    snapshot,
    workspaceName,
    currentUserId: null,
    access,
    search: "",
    sort: "az",
  };

  const entries: PickerEntry[] = [
    {
      key: "all",
      label: t("dictionary.shared.allWords"),
      count: allWordsRows(rowsInput).length,
      locked: false,
      group: "top",
    },
    {
      key: "personal",
      label: t("dictionary.shared.personal"),
      count: personalWordsShown(rowsInput).length,
      locked: false,
      group: "top",
    },
    {
      key: "allShared",
      label: t("dictionary.shared.allShared"),
      count: snapshot ? visible.length : null,
      locked,
      group: "shared",
    },
    {
      key: "workspace",
      label: workspaceListLabel(workspaceName, t),
      count: countIn(null),
      locked,
      group: "shared",
    },
  ];

  // Spaces come from the scopes the member can read, so an owner outside a space has no entry for it.
  for (const scope of snapshot?.meta?.scopes ?? []) {
    if (scope.space_id === null) continue;
    entries.push({
      key: `space:${scope.space_id}`,
      label: scope.name,
      count: countIn(scope.space_id),
      locked,
      group: "shared",
    });
  }

  // Hiding is for words that apply; a paused workspace keeps the words it hid.
  if (access === "available" || access === "paused") {
    entries.push({
      key: "hidden",
      label: t("dictionary.shared.hidden"),
      count: snapshot ? hiddenSharedEntries(snapshot).length : null,
      locked,
      group: "bottom",
    });
  }
  return entries;
}

export function defaultAddTarget(
  list: ListKey,
  // undefined is "nothing remembered"; null is the workspace list.
  lastUsed: ShareTarget | "personal" | undefined
): ShareTarget | "personal" {
  if (list === "personal") return "personal";
  if (list === "workspace") return null;
  if (list.startsWith("space:")) return list.slice("space:".length);
  return lastUsed === undefined ? "personal" : lastUsed;
}

export function shareTargetsFor(
  words: string[],
  snapshot: SharedDictionarySnapshot,
  workspaceName: string,
  t: TFunction
): Array<{ target: ShareTarget; label: string; memberCount: number; alreadyShared: boolean }> {
  const wanted = words.map(wordKey).filter(Boolean);
  const entries = readableEntries(snapshot);
  const scopes = snapshot.meta?.scopes ?? [];
  // Workspace first, then spaces in the order the server listed them.
  const ordered = [
    ...scopes.filter((scope) => scope.space_id === null),
    ...scopes.filter((scope) => scope.space_id !== null),
  ];
  return ordered.map((scope) => {
    const inList = new Set(
      entries
        .filter((entry) => entry.spaceId === scope.space_id)
        .map((entry) => wordKey(entry.word))
    );
    return {
      target: scope.space_id,
      label: scope.space_id === null ? workspaceListLabel(workspaceName, t) : scope.name,
      memberCount: scope.member_count,
      alreadyShared: wanted.length > 0 && wanted.every((word) => inList.has(word)),
    };
  });
}

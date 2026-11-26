import type { FolderItem, SpaceItem } from "../types/electron";
import { MEETINGS_FOLDER_NAME } from "./defaultFolderNames.ts";
import { activePrivateSpace } from "./workspaceSelection.ts";

type SectionSpace = Pick<SpaceItem, "id" | "kind" | "workspace_id">;
type SectionFolder = Pick<FolderItem, "id" | "space_id" | "name"> &
  Partial<Pick<FolderItem, "parent_folder_id">>;
type SectionTarget = { spaceId: number; folderId: number | null };

/**
 * The Private spaces the one Private section stands for, from spaces already in scope: the active
 * workspace's own first, then the pending one. Both are in scope while the default workspace isn't
 * known, or until main binds the pending one into the default's own.
 */
export function privateSectionSpaces<S extends SectionSpace>(scoped: S[]): S[] {
  const primary = activePrivateSpace(scoped);
  if (!primary) return [];
  return [primary, ...scoped.filter((space) => space.kind === "private" && space !== primary)];
}

/** One folder row of the Private section. */
export interface PrivateFolderGroup<F extends SectionFolder> {
  /** The row's folder: the first Private's that has one by this name. */
  folder: F;
  /** Every folder the row stands for, `folder` first. */
  members: F[];
  /** The row this one is a subfolder row of; null for a top-level row. */
  parent: PrivateFolderGroup<F> | null;
}

// A subfolder whose parent isn't a listed top-level folder of its own space (a transient sync
// state) is a top-level row, as the tree shows it (folderTree), so no folder is ever hidden.
function listedParent<F extends SectionFolder>(folder: F, folders: F[]): F | undefined {
  if (folder.parent_folder_id == null) return undefined;
  return folders.find(
    (f) =>
      f.id === folder.parent_folder_id &&
      f.space_id === folder.space_id &&
      f.parent_folder_id == null
  );
}

/**
 * The Private section's folder rows, for `sectionSpaces` in section order: folders that share a
 * name and a parent row across those Privates are one row, so no folder shows twice and neither
 * Private's notes are out of reach. Two folders of one name in the same Private stay two rows, and
 * so do a top-level folder and a subfolder of one name. Each top-level row comes before its
 * subfolder rows.
 */
export function privateSectionFolders<F extends SectionFolder>(
  sectionSpaces: Pick<SpaceItem, "id">[],
  folders: F[]
): PrivateFolderGroup<F>[] {
  const topLevel: PrivateFolderGroup<F>[] = [];
  const subfolderRows = new Map<PrivateFolderGroup<F>, PrivateFolderGroup<F>[]>();
  const rowOf = new Map<number, PrivateFolderGroup<F>>();
  // Rows by parent row, then by name: the first row of each name takes the other Privates' folders.
  const byName = new Map<PrivateFolderGroup<F> | null, Map<string, PrivateFolderGroup<F>>>();
  const place = (folder: F, parent: PrivateFolderGroup<F> | null) => {
    const names = byName.get(parent) ?? new Map<string, PrivateFolderGroup<F>>();
    byName.set(parent, names);
    const named = names.get(folder.name);
    if (named && !named.members.some((member) => member.space_id === folder.space_id)) {
      named.members.push(folder);
      rowOf.set(folder.id, named);
      return;
    }
    const group: PrivateFolderGroup<F> = { folder, members: [folder], parent };
    rowOf.set(folder.id, group);
    if (parent) subfolderRows.get(parent)!.push(group);
    else {
      topLevel.push(group);
      subfolderRows.set(group, []);
    }
    if (!named) names.set(folder.name, group);
  };
  // Top-level rows first, so every subfolder finds its parent's row.
  for (const nested of [false, true]) {
    for (const space of sectionSpaces) {
      for (const folder of folders) {
        if (folder.space_id !== space.id) continue;
        const parent = listedParent(folder, folders);
        if (!!parent !== nested) continue;
        place(folder, parent ? rowOf.get(parent.id)! : null);
      }
    }
  }
  return topLevel.flatMap((group) => [group, ...subfolderRows.get(group)!]);
}

/** One space's folder rows: a row per folder, each top-level row before its subfolder rows. */
export function spaceFolderRows<F extends SectionFolder>(
  space: Pick<SpaceItem, "id">,
  folders: F[]
): PrivateFolderGroup<F>[] {
  return privateSectionFolders([space], folders);
}

/** Folder rows as a tree: each top-level row with its subfolder rows, in order. */
export function folderRowTree<F extends SectionFolder>(
  groups: PrivateFolderGroup<F>[]
): Array<{ group: PrivateFolderGroup<F>; subfolders: PrivateFolderGroup<F>[] }> {
  const nodes: Array<{ group: PrivateFolderGroup<F>; subfolders: PrivateFolderGroup<F>[] }> = [];
  for (const group of groups) {
    if (group.parent == null) nodes.push({ group, subfolders: [] });
    else nodes.find((node) => node.group === group.parent)?.subfolders.push(group);
  }
  return nodes;
}

// Both spaces are Privates the section stands for: a move between them stays in the section.
function bothInSection(sectionSpaces: Pick<SpaceItem, "id">[], ...spaceIds: number[]): boolean {
  return spaceIds.every((spaceId) => sectionSpaces.some((space) => space.id === spaceId));
}

// The section's folder row that stands for this folder.
function rowOfFolder<F extends SectionFolder>(
  sectionSpaces: Pick<SpaceItem, "id">[],
  folders: F[],
  folderId: number
): PrivateFolderGroup<F> | undefined {
  return privateSectionFolders(sectionSpaces, folders).find((group) =>
    group.members.some((member) => member.id === folderId)
  );
}

/**
 * Where a note moved onto a Private section row lands. The section stands for each Private in it,
 * so a note from one of them stays in its own: the section takes it to its own root, and a folder
 * row to its own folder of that name, when it has one (else to the row's, a move between the
 * section's Privates). A row outside the section, or a note from outside it, lands where the row
 * points.
 */
export function privateSectionTarget<F extends SectionFolder>(
  sectionSpaces: Pick<SpaceItem, "id">[],
  folders: F[],
  noteSpaceId: number,
  target: SectionTarget
): SectionTarget {
  if (!bothInSection(sectionSpaces, noteSpaceId, target.spaceId)) return target;
  if (target.folderId == null) return { spaceId: noteSpaceId, folderId: null };
  const own = rowOfFolder(sectionSpaces, folders, target.folderId)?.members.find(
    (member) => member.space_id === noteSpaceId
  );
  return own ? { spaceId: noteSpaceId, folderId: own.id } : target;
}

/**
 * Where a note dropped on a Private section row lands, as privateSectionTarget; null on the
 * section's Meetings row for a note already in the section. That row is the note's own Meetings,
 * whichever of the section's Privates holds it, and a space's own Meetings is never a drop target.
 */
export function privateSectionDropTarget<F extends SectionFolder & Pick<FolderItem, "is_default">>(
  sectionSpaces: Pick<SpaceItem, "id">[],
  folders: F[],
  noteSpaceId: number,
  target: SectionTarget
): SectionTarget | null {
  const isOwnMeetings =
    target.folderId != null &&
    bothInSection(sectionSpaces, noteSpaceId, target.spaceId) &&
    !!rowOfFolder(sectionSpaces, folders, target.folderId)?.members.some(
      (member) => member.is_default && member.name === MEETINGS_FOLDER_NAME
    );
  return isOwnMeetings ? null : privateSectionTarget(sectionSpaces, folders, noteSpaceId, target);
}

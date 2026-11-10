import type { FolderItem, SpaceItem } from "../types/electron";
import { MEETINGS_FOLDER_NAME } from "../components/notes/shared.ts";
import { activePrivateSpace } from "./workspaceSelection.ts";

type SectionSpace = Pick<SpaceItem, "id" | "kind" | "workspace_id">;
type SectionFolder = Pick<FolderItem, "id" | "space_id" | "name">;
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
}

/**
 * The Private section's folder rows, for `sectionSpaces` in section order: folders that share a
 * name across those Privates are one row, so no folder shows twice and neither Private's notes are
 * out of reach. Two folders of one name in the same Private stay two rows.
 */
export function privateSectionFolders<F extends SectionFolder>(
  sectionSpaces: Pick<SpaceItem, "id">[],
  folders: F[]
): PrivateFolderGroup<F>[] {
  const groups: PrivateFolderGroup<F>[] = [];
  const byName = new Map<string, PrivateFolderGroup<F>>();
  for (const space of sectionSpaces) {
    for (const folder of folders) {
      if (folder.space_id !== space.id) continue;
      const named = byName.get(folder.name);
      if (named && !named.members.some((member) => member.space_id === folder.space_id)) {
        named.members.push(folder);
        continue;
      }
      const group = { folder, members: [folder] };
      groups.push(group);
      if (!named) byName.set(folder.name, group);
    }
  }
  return groups;
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

import type { FolderItem, SpaceItem } from "../types/electron";
import { activePrivateSpace } from "./workspaceSelection.ts";

type SectionSpace = Pick<SpaceItem, "id" | "kind" | "workspace_id">;
type SectionFolder = Pick<FolderItem, "id" | "space_id" | "name">;

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

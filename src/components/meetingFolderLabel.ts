import type { FolderItem, MeetingDestinationContext } from "../types/electron";
import { defaultFolderDisplayName } from "./notes/shared";
const key = (name: string) => `meetingNotification.folders.${name}`;
export function meetingLocationLabel(
  shared: boolean,
  spaceName: string,
  folderName: string | null,
  t: (key: string) => string
): string {
  return `${shared ? spaceName : t(key("private"))}${folderName ? ` / ${folderName}` : ""}${shared ? ` · ${t(key("shared"))}` : ""}`;
}
export function meetingFolderLabel(
  context: MeetingDestinationContext,
  folder: FolderItem,
  t: (key: string) => string
): string {
  const space = context.spaces.find((s) => s.id === folder.space_id);
  return meetingLocationLabel(
    space?.kind === "team",
    space?.name ?? "",
    defaultFolderDisplayName(folder, t),
    t
  );
}

import {
  FolderRounded,
  ListEnd,
  Mail,
  Send,
  Sparkles,
  SquareSlash,
  type IconComponent,
} from "../icons";

const ACTION_ICONS: Record<string, IconComponent> = {
  mail: Mail,
  "clipboard-check": ListEnd,
  "file-text": FolderRounded,
  send: Send,
  sparkles: Sparkles,
};

// An icon this build doesn't know (say, one synced from a newer client) shows the "/" of a command.
export const getActionIcon = (action: { icon: string }): IconComponent =>
  ACTION_ICONS[action.icon] ?? SquareSlash;

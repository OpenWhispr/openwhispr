import {
  FolderRounded,
  ListEnd,
  Mail,
  MessageSquareText,
  Send,
  Sparkles,
  SquareSlash,
  type IconComponent,
} from "../icons";

const ACTION_ICONS: Record<string, IconComponent> = {
  mail: Mail,
  "message-square-text": MessageSquareText,
  "clipboard-check": ListEnd,
  "file-text": FolderRounded,
  send: Send,
  sparkles: Sparkles,
};

// An icon this build doesn't know (say, one synced from a newer client) shows the "/" of a command.
export const getActionIcon = (action: { icon: string }): IconComponent =>
  ACTION_ICONS[action.icon] ?? SquareSlash;

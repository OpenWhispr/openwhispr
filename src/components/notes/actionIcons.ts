import {
  FolderRounded,
  ListEnd,
  Mail,
  MessageSquareText,
  Send,
  Sparkles,
  type IconComponent,
} from "../icons";

const ACTION_ICONS: Record<string, IconComponent> = {
  mail: Mail,
  "clipboard-check": ListEnd,
  "file-text": FolderRounded,
  send: Send,
  sparkles: Sparkles,
};

export const getActionIcon = (action: { icon: string }): IconComponent =>
  ACTION_ICONS[action.icon] ?? MessageSquareText;

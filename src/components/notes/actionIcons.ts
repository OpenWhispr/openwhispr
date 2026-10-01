import {
  ClipboardCheck,
  FileText,
  Mail,
  MessageSquareText,
  Send,
  Sparkles,
  type IconComponent,
} from "../icons";

const ACTION_ICONS: Record<string, IconComponent> = {
  mail: Mail,
  "clipboard-check": ClipboardCheck,
  "file-text": FileText,
  send: Send,
  sparkles: Sparkles,
};

export const getActionIcon = (action: { icon: string }): IconComponent =>
  ACTION_ICONS[action.icon] ?? MessageSquareText;

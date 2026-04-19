import { Search, Globe, ClipboardCheck, Calendar, FileText, FilePlus, FilePen } from "lucide-react";

export const toolIcons: Record<string, typeof Search> = {
  search_notes: Search,
  web_search: Globe,
  copy_to_clipboard: ClipboardCheck,
  get_calendar_events: Calendar,
  get_note: FileText,
  create_note: FilePlus,
  update_note: FilePen,
};

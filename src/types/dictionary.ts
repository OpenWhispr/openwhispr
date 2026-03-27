export type DictionaryEntryKind =
  | "manual"
  | "person"
  | "project"
  | "organization"
  | "technical"
  | "legacy";

export type DictionaryEntrySource =
  | "manual"
  | "auto_learn"
  | "otter_glossary"
  | "legacy";

export interface DictionaryEntry {
  id?: number;
  term: string;
  normalizedTerm?: string;
  kind: DictionaryEntryKind;
  source: DictionaryEntrySource;
  priority: number;
  pinned: boolean;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface DictionaryPromptSelection {
  prompt: string | null;
  totalEntries: number;
  enabledEntries: number;
  selectedEntries: DictionaryEntry[];
  droppedEntries: number;
  maxChars: number;
}

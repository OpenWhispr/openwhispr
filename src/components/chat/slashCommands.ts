export interface SlashCommand {
  id: string;
  label: string;
  /** A short tag after the label, such as where the command's output goes. */
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/**
 * The commands a draft of "/" (or the full-width "／" a CJK input method types)
 * plus a filter asks for, none when it isn't one.
 * Labels with a word starting with the filter come first, so "/s" offers
 * "Shorten" before "Make to-dos"; any other match still counts, since labels
 * in languages written without spaces have no words to start.
 */
export function matchSlashCommands(commands: SlashCommand[], draft: string): SlashCommand[] {
  const query = /^[/／]([^\n]*)$/.exec(draft)?.[1].trim().toLowerCase();
  if (query === undefined) return [];
  const startsAWord = (label: string) =>
    label.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query));
  return commands
    .map((command) => ({ command, label: command.label.toLowerCase() }))
    .filter(({ label }) => label.includes(query))
    .sort((a, b) => Number(!startsAWord(a.label)) - Number(!startsAWord(b.label)))
    .map(({ command }) => command);
}

export const slashOptionId = (menuId: string, index: number) => `${menuId}-${index}`;

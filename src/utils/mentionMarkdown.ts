export interface MentionPerson {
  name: string;
  email: string | null;
}

export const MENTION_HREF_PREFIX = "mention:";

const sanitizeLabel = (name: string) =>
  name
    .replace(/[[\]\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// encodeURIComponent leaves ( and ) alone, which would end the markdown link early.
const encodeMentionId = (id: string) =>
  encodeURIComponent(id).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A mention serializes as a plain markdown link, so exports and other markdown
 * consumers degrade to a readable `@Name` link instead of losing the tag. */
export function buildMentionMarkdown(person: MentionPerson): string {
  const label = sanitizeLabel(person.name);
  return `[@${label}](${MENTION_HREF_PREFIX}${encodeMentionId(person.email || label)})`;
}

export function parseMentionEmail(href: string | null): string | null {
  if (!href?.startsWith(MENTION_HREF_PREFIX)) return null;
  try {
    const id = decodeURIComponent(href.slice(MENTION_HREF_PREFIX.length));
    return id.includes("@") ? id : null;
  } catch {
    return null;
  }
}

const TASK_OWNER_LINE = /^(\s*[-*]\s*\[[ xX]\]\s+\S.*?)(\s+[—–-]\s+)(\S.*?)\s*$/;
const OWNER_SPLIT = /\s*(?:,|&|\/|\band\b)\s*/i;

interface NameIndex {
  byFullName: Map<string, MentionPerson>;
  byFirstName: Map<string, MentionPerson | null>;
}

function buildNameIndex(people: MentionPerson[]): NameIndex {
  const byFullName = new Map<string, MentionPerson>();
  for (const person of people) {
    const name = sanitizeLabel(person.name).toLowerCase();
    if (name && !byFullName.has(name)) byFullName.set(name, person);
  }
  // First names resolve only when unambiguous across all known people.
  const byFirstName = new Map<string, MentionPerson | null>();
  for (const [fullName, person] of byFullName) {
    const first = fullName.split(" ")[0];
    byFirstName.set(first, byFirstName.has(first) ? null : person);
  }
  return { byFullName, byFirstName };
}

function matchOwner(raw: string, index: NameIndex): MentionPerson | null {
  const owner = raw.trim().replace(/^@/, "").replace(/[.:]$/, "").toLowerCase();
  if (!owner) return null;
  return index.byFullName.get(owner) ?? index.byFirstName.get(owner) ?? null;
}

/**
 * Converts the trailing owner of `- [ ] Action — Owner` checkbox lines into
 * mention links when the owner matches a known person, so generated action
 * items render as tagged owner chips in the editor. Lines with unknown or
 * ambiguous owners are left untouched.
 */
export function tagActionItemOwners(markdown: string, people: MentionPerson[]): string {
  if (!markdown || people.length === 0) return markdown;
  const index = buildNameIndex(people);
  if (index.byFullName.size === 0) return markdown;

  return markdown
    .split("\n")
    .map((line) => {
      if (line.includes(MENTION_HREF_PREFIX)) return line;
      const match = line.match(TASK_OWNER_LINE);
      if (!match) return line;
      const [, task, separator, ownerText] = match;
      const parts = ownerText.split(OWNER_SPLIT).filter(Boolean);
      if (parts.length === 0) return line;
      const owners = parts.map((part) => matchOwner(part, index));
      if (owners.some((owner) => owner == null)) return line;
      return `${task}${separator}${owners
        .map((owner) => buildMentionMarkdown(owner as MentionPerson))
        .join(", ")}`;
    })
    .join("\n");
}

const firstCharacter = (text: string): string => Array.from(text)[0] ?? "";

/** First and last word's initials ("Chad Piha" → "CP"), else the email's first character. */
export function avatarInitials(name: string | null, email: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const last = words.length > 1 ? firstCharacter(words[words.length - 1]) : "";
    return (firstCharacter(words[0]) + last).toUpperCase();
  }
  return firstCharacter((email ?? "").trim()).toUpperCase() || "?";
}

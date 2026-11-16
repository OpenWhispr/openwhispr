import {
  bareEmailAddress,
  emailBodyBytes,
  isValidEmailAddress,
  MAX_EMAIL_BODY_BYTES,
  MAX_EMAIL_RECIPIENTS,
  MAX_EMAIL_SUBJECT_LENGTH,
} from "../helpers/connectors/emailCompose";

/** An email card's fields, exactly as Send commits them. */
export interface EmailFields {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

/** What blocks Send, in the order the card names it. */
export interface EmailFieldProblems {
  invalid: string[];
  missingTo: boolean;
  tooManyRecipients: boolean;
  subjectTooLong: boolean;
  bodyTooLong: boolean;
}

// Commas as typed in every locale (Arabic ، and the CJK fullwidth ， and 、),
// and the semicolons Outlook users type between addresses.
const ADDRESS_SEPARATOR = /[,;،，、]/;

/**
 * The addresses in a To or Cc input, in order. A pasted "Name <address>"
 * becomes its bare address, which is what Send uses; anything else is kept
 * as typed, so a bad one is named on the card. A part with no address before
 * a "Name <address>" reads as the start of that name (Outlook's "Last, First
 * <address>"), so "josh, Dana <dana@acme.com>" is Dana alone; the card shows
 * the resolved addresses whenever a name was stripped.
 */
export function parseAddressList(text: string): string[] {
  const parts = text
    .split(ADDRESS_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const addresses: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    let part = parts[index];
    // Outlook copies "Smith, Bob <bob@acme.com>": a part with no address of
    // its own is the start of the next part's display name.
    if (!/[@<]/.test(part) && parts[index + 1]?.includes("<")) {
      part = `${part} ${parts[++index]}`;
    }
    addresses.push(bareEmailAddress(part));
  }
  return addresses;
}

/**
 * What blocks Send. A display-name form ("Josh <josh@acme.com>") that
 * reached the fields some other way counts as invalid: main would send to
 * the bare address, which isn't what the card shows. The limits are main's,
 * so a card never ends in a failure the user could have fixed.
 */
export function emailFieldProblems(fields: EmailFields): EmailFieldProblems {
  const all = [...fields.to, ...fields.cc];
  const invalid = all.filter(
    (address) =>
      bareEmailAddress(address) !== address.normalize("NFC") || !isValidEmailAddress(address)
  );
  // Main sends each address once, however often the card lists it.
  const recipients = new Set(all.map((address) => address.toLowerCase())).size;
  return {
    invalid,
    missingTo: fields.to.length === 0,
    tooManyRecipients: recipients > MAX_EMAIL_RECIPIENTS,
    subjectTooLong: [...fields.subject].length > MAX_EMAIL_SUBJECT_LENGTH,
    bodyTooLong: emailBodyBytes(fields.body) > MAX_EMAIL_BODY_BYTES,
  };
}

export function hasEmailFieldProblem(problems: EmailFieldProblems): boolean {
  return (
    problems.invalid.length > 0 ||
    problems.missingTo ||
    problems.tooManyRecipients ||
    problems.subjectTooLong ||
    problems.bodyTooLong
  );
}

/** The email layout's fields, read from a draft's generic fields map. */
export function toEmailFields(fields: Record<string, string | string[]>): EmailFields {
  const list = (value: string | string[] | undefined): string[] =>
    Array.isArray(value) ? value : [];
  const text = (value: string | string[] | undefined): string =>
    typeof value === "string" ? value : "";
  return {
    to: list(fields.to),
    cc: list(fields.cc),
    subject: text(fields.subject),
    body: text(fields.body),
  };
}

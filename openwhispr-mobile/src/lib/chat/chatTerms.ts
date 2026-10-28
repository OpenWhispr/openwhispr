// How a chat search term is matched. The note search (SQL) and the transcript passages sent with a
// note (JS) share these, so a note found by a term is sent with the lines that term found.

// Digits, or digit groups joined by `.`, `,` or `:` ("1.10", "10,000"). GLOB knows only ASCII
// digits, so only those make a number.
export const NUMBER_TERM = /^[0-9]+(?:[.,:][0-9]+)*$/;

// A short Latin term ("ai", "q3") would match inside longer words ("said", "email"), so it matches
// whole words only.
export const WHOLE_WORD_TERM = /^[a-z0-9]{1,2}$/;

// A longer Latin term matches only where a word starts: "more" never matches "Furthermore", while
// "budget" still finds "budgets". Terms from other scripts match anywhere, since Korean particles
// attach to the nouns they follow.
export const LATIN_WORD_TERM = /^[\p{Script=Latin}0-9]+$/u;

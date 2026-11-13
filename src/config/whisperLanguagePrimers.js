// Whisper continues the style of its prompt. With language=el and no prompt it
// tends to transliterate English words into Greek ("μίτινγκ" for "meeting").
// A short primer written the way Greek speakers actually type — Greek text with
// English terms left in Latin script — steers it to keep code-switched words as
// spoken. The primer is plain, neutral text, so an echo on silence is caught by
// the dictionary echo filter (it is passed there alongside the dictionary).
const PRIMERS = {
  el: "Καλημέρα, έστειλα το email για το meeting. Θα κάνω deploy το update στο server και θα ανοίξω ένα ticket στο GitHub.",
};

export function getWhisperLanguagePrimer(language) {
  return (language && PRIMERS[language]) || null;
}

// Primer first, dictionary after: whisper.cpp keeps the end of an over-long
// prompt, so the user's own words are never the part that gets cut.
export function withLanguagePrimer(language, dictionaryPrompt) {
  const primer = getWhisperLanguagePrimer(language);
  if (!primer) return dictionaryPrompt || null;
  return dictionaryPrompt ? `${primer} ${dictionaryPrompt}` : primer;
}

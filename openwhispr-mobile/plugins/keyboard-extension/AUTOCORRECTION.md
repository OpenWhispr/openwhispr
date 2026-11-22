# Keyboard autocorrection

The keyboard corrects a word the user typed by hand when they tap space, `?`, `!`, `.` or `,`. It is on by default
and works on the device only: public `UITextChecker` APIs, no network, no learned dictionary,
and no typed text in logs.

## Settings

**Settings → Preferences → Keyboard → Autocorrection** (iOS only) has an on/off switch
(default on) and the languages to correct: multiple choice, German and English by default, at
least one and at most three. The Preferences row shows the selection, or "Off".

- The app saves `keyboardAutocorrectionEnabled` and `keyboardAutocorrectionLanguages` in its
  config and mirrors them to the App Group as `keyboard_autocorrection_enabled` (`"1"`/`"0"`)
  and `keyboard_autocorrection_languages` (`"de,en"`), see `src/lib/keyboardAutocorrectionSync.ts`.
- The keyboard reads both at every manual space, so a change applies without reopening it.
  Only an explicit `"0"` switches correction off. `KeyboardCorrectionLanguage.selection(from:)`
  ignores unknown codes, drops duplicates and caps the list at three; nothing usable means
  German and English. The controller rebuilds `TextCheckerCorrectionProvider` only when the
  parsed selection changes.
- Correction needs no Full Access, but without it the keyboard can't read the App Group, so it
  corrects German and English whatever the app says.

### Adding a language

1. Add a `KeyboardCorrectionLanguage` in `ios/KeyboardAutocorrection.swift`: its code, its
   preferred `UITextChecker` identifiers and the lowercase letters its words may use (e.g.
   `é è ê ç …` for French), and list it in `all`.
2. Add the same code and label to `KEYBOARD_AUTOCORRECTION_LANGUAGES` in
   `src/lib/keyboardAutocorrection.ts`. A Jest test fails while the two lists differ.
3. Add rule tests with the language's letters and check it on an iPhone with that dictionary.

## What gets corrected

- Only a manually tapped space, `?`, `!`, `.` or `,` key starts a correction; the mark is
  typed after the replacement (`nciht?` → `nicht?`). Other punctuation doesn't. There is no
  suggestion bar. A word ending in `.` is corrected too, so a domain typed as a word can be
  (`openwhsipr.com`); backspace right after undoes it.
- A `?`, `!`, `.` or `,` typed after a single space that follows a letter or digit deletes
  that space first (`nicht ?` → `nicht?`, also after a correcting space), with autocorrection on,
  in fields where it's allowed and `smartInsertDeleteType` isn't `.no`
  (`KeyboardAutocorrection.removesSpace`). Two spaces, a space after punctuation
  (`- .`) and selections are left alone.
- Dictionaries: German prefers `de_DE`, `de-DE`, `de`, then another German variant; English
  `en_US`, `en-US`, `en_GB`, `en-GB`, `en`, then another English variant. A missing dictionary
  is skipped; with none, nothing is corrected.
- A word is corrected only when every selected dictionary flags the whole word as misspelled,
  so an English word in German text (or the reverse) stays. Two exceptions follow below: the
  sentence's language, and German typed without umlauts.
- **The sentence's language.** With several languages selected, the keyboard looks at the last
  eight words before the cursor (two letters or more). When some are known to only one
  selected language and none only to another, the sentence is in that language, and a word only
  another language knows counts as a typo, unless it is common there (among the first 25
  completions of its first two letters): `woe` in a German sentence becomes `wie`, while `cool`
  stays. Mixed or empty context keeps the rule above.
- Only the selected languages' letters count (German a–z and äöüß, English a–z), limited to
  languages whose dictionary is installed.

### Choosing a replacement

`KeyboardCorrectionRules.replacement` scores every candidate: its weighted edit distance to the
typed word plus 0.3 per doubling of its frequency rank. The lowest score wins; there is no
"ambiguous, do nothing", so a wrong word is possible, and backspace right after undoes it.

- Edit weights (`editCost`, optimal string alignment): a wrong letter on the key beside the
  right one in its row 1, on a touching key in the row above or below 1.5 (`keyNeighbors`, the
  keyboard's own QWERTY rows), a letter for its umlaut (a↔ä, o↔ö, u↔ü, s↔ß) 1, any other wrong
  letter 2, a swap of adjacent letters 1, a missing or extra letter 1.5.
- Most weight allowed (`maxEditCost`): 1.5 for three letters, 2.5 for four, 4 for five or six,
  5 from seven: roughly one, two, three and four mistakes.
- Frequency (`frequencyRank`): the candidate's position among `UITextChecker`'s completions of
  its first two letters, which Apple orders by likelihood; cached per dictionary and prefix (at
  most 48 lists). Unknown counts as rank 20,000.
- A capitalised word keeps its capital; case otherwise changes only for German nouns (below).
- Examples: `nciht` → `nicht`, `teh` → `the`, `kalppt` → `klappt`, `fubktiojiert` →
  `funktioniert`, `njxbt` → `nicht`, `wirklixh` → `wirklich`, `hsbd` → `habe` (two slips like
  `hand`, but about three times as common).

### Own candidates

`UITextChecker` doesn't always propose swaps or missing/extra letters and rarely words several
slips away, so the provider also builds variants and keeps those a selected dictionary knows:
every single swap, missing and extra letter (`singleEditCandidates`), then words with one, two
and three neighbouring-key slips (`neighborSlipCandidates`; one slip in three-letter words, two
in four-letter words). All levels are searched, since a common word with more slips can beat a
rare one with fewer; a level that would pass 1,500 variants is skipped with the levels after
it. The space press waits for this, so the search stops after 100 ms and drops the level it
was in.

### German without umlauts, and nouns

German selected only.

- **ae/oe/ue/ss**: an unknown word whose spelling with ä/ö/ü (Ä/Ö/Ü at the start of a
  capitalised word) or ß is a German word becomes that word, ahead of every other candidate
  (`schoen` → `schön`, `Aerger` → `Ärger`, `gruesse` → `grüße`, `groesser` → `größer`). Each
  pair is a choice (`transcriptions`, at most six pairs); the respelling replacing the most
  pairs wins (`grüße` over the Swiss `grüsse`), then ß 0.5 and an umlaut 0.3 plus frequency.
- A word some dictionary accepts as typed (English, Swiss spellings, words iOS has learned) is
  respelled only when it isn't a common word in any selected dictionary and the respelling is
  German (`moechte` → `möchte`); a ß respelling also needs German not to know the ss spelling,
  or the ß spelling to be common. So `neue`, `Feuer`, `Michael`, `dass`, `muss`, `Masse`,
  `Busse`, `sued` and `phoenix` stay.
- **Nouns** are capitalised for users who type in lowercase: a lowercase word that German's
  completions list only capitalised, and that no selected dictionary lists in lowercase, gets
  its capital, typed right (`haus` → `Haus`) or corrected (`strasse` → `Straße`, `hsus` →
  `Haus`). Words with both forms (`essen`/`Essen`, `morgen`/`Morgen`), verbs, adjectives and
  English words (`hand` with English selected) stay. Where the completions don't contain the
  word itself, it stays lowercase.

### Tuning

Weights and the frequency factor were chosen offline on the 50,000 most common German and
English words (FrequencyWords lists, not shipped) with random typos, running the production
Swift rules with a stand-in dictionary. Without Apple's own proposals (worst case): one mistake
(slips, swaps, missing and extra letters) about 90% right and 9% wrong; two slips 75% right and
23% wrong; three slips 42% right, 21% wrong and the rest unchanged.

### Never corrected

- Digits, punctuation, underscores, mixed or all caps, URL- and email-like tokens, emoji,
  decomposed combining sequences, words under three or over twenty letters, and words following
  punctuation.
- Fields other than default text fields: secure fields, fields hiding their text,
  `.autocorrectionType == .no`, URL, email, ASCII-only, numeric and other specialised keyboard
  types. Selections are never replaced.
- Existing text, dictation and assistant output: `typeText` only invalidates correction state.

## Replacement and undo safety

`KeyboardAutocorrection.swift` is Foundation-only; its provider protocol keeps proposals
independent of the controller. It tracks the expected host context after manual inserts, not
just the word. Before a replacement the controller reads both sides of the cursor, the
selection, field traits and document UUID, and requires an exact match with the expected
context; after querying the checker it reads them all again, immediately before deleting.
Missing left context in a non-empty field, or delayed, truncated or contradictory context,
abandons the correction and inserts an ordinary space.

UIKit may report `nil` or an empty string on the right at the end of a document; both compare
as equal, as do nil and empty selections. Non-empty right context must match exactly. A `nil`
left context seeds tracking as empty only when the proxy reports `hasText == false`, nothing on
the right and no selection; it never authorises a replacement by itself.

Will-change callbacks suspend replacement. Did-change callbacks keep the pending word or undo
only when the new context exactly matches the keyboard's own insertion; anything else
invalidates it, and a space or backspace before the report fails closed. Cursor moves,
selections, field and keyboard switches, appearing and disappearing invalidate tracking.

Backspace within **3 seconds** of a correction (`KeyboardAutocorrection.undoWindow`) deletes the
corrected word and its space, `?`, `!`, `.` or `,` (`Edit.delimiter`) and restores the original without
it; later, backspace is ordinary and deletes that character. Letters typed right after a
correcting mark are never tracked as a word. Undo needs the same document and an exact, freshly read
context, and is one-shot; the restored word isn't tracked, so the next space doesn't correct it
again. Held backspace keeps its normal repeating deletion.

Word indexing and deletion use Swift `Character`; only the provider uses UTF-16
`NSRange(_:in:)` for Apple's API. Public proxy reads can't form an atomic transaction with the
host, so the keyboard fails closed on observable changes; it can't detect an unreported cursor
move to an identical context. No private host APIs are used.

OSLog entries contain only fixed reasons, flags, counts and the sentence's language code, never
words, surrounding text, proposals or document UUIDs.

## Tests

From `openwhispr-mobile/` (the native ones need macOS and Xcode, except the rules script,
which runs wherever `swiftc` and Foundation are installed):

```bash
sh scripts/test-keyboard-autocorrection.sh
python3 plugins/keyboard-extension/tests/run-keyboard-touch-tests.py
npm test -- --runInBand
```

- `tests/KeyboardAutocorrectionTests.swift`: language selection, sentence language, scoring,
  key neighbours, generated candidates, respellings, excluded tokens, Unicode, context
  invalidation, delayed reports, document boundaries, own-change acknowledgements and undo
  (including the 3-second window). Jest runs it when `swiftc` is available and skips it
  otherwise.
- `tests/KeyboardTouchTests.swift` (Catalyst): the controller with a stub provider: correction,
  the Settings switch, English, neighbouring-key slips, umlaut respelling, noun capitalisation,
  undo and its window, recorrection suppression, double space, silent hosts, cursor changes,
  field guards, transcript exclusion and held delete.
- Jest: the settings screen and Preferences row, the App Group mirror, the language list kept in
  step with the keyboard's, and source registration in `withKeyboardExtension.js`.

`KeyboardAutocorrection.swift` and `TextCheckerCorrectionProvider.swift` are registered in
`withKeyboardExtension.js`; a native rebuild is required.

## Checks on an iPhone

1. With Full Access, switch Autocorrection off: `nciht` + space stays. Switch it on without
   reopening the keyboard: `nciht` + space → `nicht`. `teh` → `the`; backspace within three
   seconds → `teh`, later it only deletes the space.
2. Deselect English: `teh` stays, `nciht` → `nicht`. The last language can't be deselected.
3. `fubktiojiert`, `njxbt`, `kalppt`, `wirklixh` → `funktioniert`, `nicht`, `klappt`,
   `wirklich`. `schoen`, `moechte`, `strasse`, `gruesse` → `schön`, `möchte`, `Straße`,
   `grüße`; `dass`, `muss`, `Masse` stay. `haus` → `Haus`; `essen`, `morgen` stay.
   `das ist woe` → `wie`; `this is woe` and `das ist cool` stay.
4. Notes, Messages and a Safari text area, with fast typing: no correction is better than one in
   the wrong place. Move the cursor, select text, switch fields, apps and keyboards: no stale
   replacement.
5. Password, URL, email and `.no` fields, `foo_bar`, `fooBar`, numbers, emoji, dictation and
   assistant output: unchanged.

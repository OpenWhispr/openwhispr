"""Builds the keyboard's bundled emoji catalog.

    python3 -I tools/build-emoji.py [--words]

Reads Unicode's emoji-test.txt and the English and German CLDR annotations that
`tools/fetch-sources.sh` downloaded into data/.cache (Unicode License v3; see data/LICENSES.md)
and writes ios/Resources/emoji.bin, the file `EmojiCatalog.swift` maps into memory.
Deterministic: the same downloads give the same bytes. `--words` also prints the word → emoji
table per language, for reviewing the stop list.

The file is UTF-8 text. Its first line is the directory:

    OWEM1 <TAB> <section>:<byte length> <TAB> …

The sections follow that line in the order listed, so a section's offset is the directory's
length plus the lengths before it. Every section is lines ending in "\\n":

    cat:<id>      one line per emoji in keyboard order: "<version> <emoji> [<5 skin tones>]".
                  The version is the Emoji version times ten (E13.1 → 131), the highest of the
                  emoji and its tones, so the keyboard only asks the system whether it can draw
                  the ones newer than its deployment target. Tones go light to dark.
    names:<lang>  one line per emoji, all categories in order: the CLDR name as written.
    search:<lang> one line per emoji: "<name words> <TAB> <keyword words>", folded (lower case,
                  no diacritics, ß as ss), keyword words that aren't in the name already.
    words:<lang>  "<word> <TAB> <emoji index>", the word in lower case, sorted by its UTF-8 bytes:
                  the one emoji the suggestion bar offers for a typed word.

Languages are en and de. An emoji's index is its line number across the categories.
"""

import html
import re
import sys
import unicodedata
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
CACHE = PLUGIN / "data/.cache"
OUT = PLUGIN / "ios/Resources/emoji.bin"
LANGUAGES = ("en", "de")

# Apple's tab order. Apple shows Smileys & Emotion and People & Body as one category and
# Activity before Travel & Places; emoji-test.txt has them the other way round.
CATEGORIES = (
    ("smileys", ("Smileys & Emotion", "People & Body")),
    ("animals", ("Animals & Nature",)),
    ("food", ("Food & Drink",)),
    ("activity", ("Activities",)),
    ("travel", ("Travel & Places",)),
    ("objects", ("Objects",)),
    ("symbols", ("Symbols",)),
    ("flags", ("Flags",)),
)
TONES = (0x1F3FB, 0x1F3FC, 0x1F3FD, 0x1F3FE, 0x1F3FF)
VARIATION_SELECTOR = 0xFE0F

# Words that are an emoji's name or keyword but that people type all the time as ordinary words.
# The suggestion bar never offers an emoji for these.
STOP_WORDS = {
    "en": """
        a about after again all also an and any are as at back be been before but by can come could
        day did do does down even end first for free from get go good had has have he her here him
        his how i if in into is it its just know like look make man many may me more most much must
        my new no not now of off ok okay on one only or other our out over people right said same
        see she should so some soon such take than that the their them then there these they thing
        think this those time to too top two up us use very want was way we well were what when
        where which who why will with woman work would yes you your
        cool cross left mark open play sign stop wait
        cancer collision cooking customs divide fly information keycap link locked mate minus
        multiply pick plus prohibited registered restroom unlocked warning watch wireless
    """.split(),
    "de": """
        ab aber alle als also am an auch auf aus bei bin bis bist da damit dann das dass dein dem
        den der des dich die dir doch du durch ein eine einem einen einer er es etwas euch für
        ganz gut hab habe haben hat hatte hier ich ihm ihn ihr im immer in ist ja jetzt kann kein
        keine man mehr mein mich mir mit nach nein neu nicht noch nur ob oben oder ok okay schon
        sehr sein sich sie sind so über um und uns unten unter vom von vor war was weg weil wenn
        wer wie wieder will wir wird wo zu zum zur zurück zwei frei frau mann zeit tag ende
        aufnehmen auswerfen blasen damen funkeln herren kreuz mal minus pause plus stopp taste
        verboten warnung wiedergabe wiederholen zurückspulen
    """.split(),
}

# Hand-picked words whose obvious emoji isn't named that word.
CURATED_WORDS = {
    "en": {
        "heart": "❤️", "love": "❤️", "dog": "🐶", "cat": "🐱", "happy": "😊", "smile": "😊",
        "sad": "😢", "laugh": "😂", "lol": "😂", "kiss": "😘", "party": "🎉", "birthday": "🎂",
        "thanks": "🙏", "coffee": "☕", "beer": "🍺", "wine": "🍷", "sun": "☀️", "star": "⭐",
        "music": "🎵", "money": "💰", "car": "🚗", "home": "🏠", "house": "🏠", "phone": "📱",
        "cake": "🍰", "christmas": "🎄", "congrats": "🎉", "congratulations": "🎉",
    },
    "de": {
        "herz": "❤️", "liebe": "❤️", "hund": "🐶", "katze": "🐱", "glücklich": "😊",
        "traurig": "😢", "lachen": "😂", "kuss": "😘", "party": "🎉", "geburtstag": "🎂",
        "danke": "🙏", "kaffee": "☕", "bier": "🍺", "wein": "🍷", "sonne": "☀️", "stern": "⭐",
        "musik": "🎵", "geld": "💰", "auto": "🚗", "haus": "🏠", "handy": "📱", "kuchen": "🍰",
        "weihnachten": "🎄", "glückwunsch": "🎉",
    },
}


def fold(text):
    """Lower case, diacritics dropped, ß as ss. `EmojiCatalog.fold` must give the same."""
    decomposed = unicodedata.normalize("NFD", text.lower().replace("ß", "ss"))
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def words_of(text):
    """The folded words of a name or keyword: runs of letters and digits."""
    return re.findall(r"[^\W_]+", fold(text))


def skeleton(emoji):
    """An emoji without its skin tones and variation selectors, to match a tone with its base."""
    return "".join(c for c in emoji if ord(c) not in TONES and ord(c) != VARIATION_SELECTOR)


def annotation_key(emoji):
    """How CLDR keys an emoji: without variation selectors. Skin tones stay, or a toned
    variant's name ("thumbs up: dark skin tone") would replace its base emoji's."""
    return emoji.replace(chr(VARIATION_SELECTOR), "")


def read_emoji():
    """Categories of [emoji, tenths-version, tone variants], in the file's order."""
    by_group = {}
    group = None
    line_pattern = re.compile(r"^([0-9A-F ]+?)\s*; fully-qualified\s*# \S+ E(\d+)\.(\d) (.+)$")
    for line in (CACHE / "emoji/emoji-test.txt").read_text(encoding="utf-8").splitlines():
        if line.startswith("# group: "):
            group = line[len("# group: "):].strip()
            continue
        match = line_pattern.match(line)
        if not match:
            continue
        emoji = "".join(chr(int(code, 16)) for code in match.group(1).split())
        version = int(match.group(2)) * 10 + int(match.group(3))
        by_group.setdefault(group, []).append((emoji, version, match.group(4)))

    categories = []
    for identifier, groups in CATEGORIES:
        entries = []
        bases = {}
        for group in groups:
            for emoji, version, name in by_group[group]:
                tones = [ord(c) for c in emoji if ord(c) in TONES]
                if not tones:
                    entry = {"emoji": emoji, "version": version, "tones": [], "name": name}
                    if skeleton(emoji) in bases:
                        raise SystemExit(f"Two emoji look the same without selectors: {emoji}")
                    bases[skeleton(emoji)] = entry
                    entries.append(entry)
                    continue
                # Two people with two different tones would be 25 choices; like Apple's first
                # level, offer the five where both have the same tone.
                if len(set(tones)) > 1:
                    continue
                base = bases.get(skeleton(emoji))
                if base is None:
                    raise SystemExit(f"A skin tone variant comes before its base: {emoji}")
                base["tones"].append((TONES.index(tones[0]), emoji))
                base["version"] = max(base["version"], version)
        for entry in entries:
            entry["tones"] = [emoji for _, emoji in sorted(entry["tones"])]
            if len(entry["tones"]) not in (0, len(TONES)):
                raise SystemExit(f"Expected five skin tones for {entry['emoji']}")
        categories.append((identifier, entries))
    return categories


def read_annotations(language):
    """CLDR's name and keywords by `annotation_key`."""
    names, keywords = {}, {}
    pattern = re.compile(r'<annotation cp="([^"]*)"((?: [a-z]+="[^"]*")*)>(.*?)</annotation>')
    for kind in ("annotations", "annotationsDerived"):
        text = (CACHE / f"cldr/{kind}-{language}.xml").read_text(encoding="utf-8")
        for key, attributes, value in pattern.findall(text):
            key, value = annotation_key(html.unescape(key)), html.unescape(value)
            if 'type="tts"' in attributes:
                names[key] = value.strip()
            else:
                keywords[key] = [keyword.strip() for keyword in value.split("|")]
    return names, keywords


def word_key(word):
    """How the suggestion bar's words are keyed: lower case only. Diacritics stay, or German
    "Bar" would offer the bear of "Bär". `EmojiCatalog.wordKey` must give the same."""
    return unicodedata.normalize("NFC", word.lower())


def emoji_words(language, entries):
    """The one emoji the suggestion bar offers for a word, by word key.

    Conservative on purpose, strongest evidence first: a hand-picked word; the emoji's whole
    name ("pizza", "Feuer"), the first emoji in keyboard order when several share it; then a
    flag's country. A keyword alone is never enough: CLDR's keywords are loose ("away" for 💨,
    "great" for 👏), and even the ones only a single emoji has are mostly ordinary words. Stop
    words and words under three letters never get an emoji.
    """
    stop = {word_key(word) for word in STOP_WORDS[language]}
    table = {}

    def offer(name, index):
        words = re.findall(r"[^\W_]+", word_key(name))
        if len(words) == 1 and len(words[0]) >= 3 and words[0] not in stop and not words[0].isdigit():
            table.setdefault(words[0], index)

    index_of = {skeleton(entry["emoji"]): index for index, entry in enumerate(entries)}
    for word, emoji in CURATED_WORDS[language].items():
        offer(word, index_of[skeleton(emoji)])
    for index, entry in enumerate(entries):
        offer(entry["names"][language], index)
    for index, entry in enumerate(entries):
        # "flag: Germany", "Flagge: Deutschland"
        label, colon, country = entry["names"][language].partition(": ")
        if entry["category"] == "flags" and colon:
            offer(country, index)
    return table


def main():
    categories = read_emoji()
    entries = []
    for identifier, category in categories:
        for entry in category:
            entry["category"] = identifier
            entry["names"], entry["keywords"] = {}, {}
            entries.append(entry)
    for language in LANGUAGES:
        names, keywords = read_annotations(language)
        english_names = read_annotations("en")[0]
        for entry in entries:
            key = annotation_key(entry["emoji"])
            # Emoji newer than the CLDR download have no annotation yet.
            entry["names"][language] = names.get(key) or english_names.get(key) or entry["name"]
            entry["keywords"][language] = keywords.get(key, [])

    sections = []
    for identifier, category in categories:
        lines = [" ".join([str(entry["version"]), entry["emoji"], *entry["tones"]]) for entry in category]
        sections.append((f"cat:{identifier}", lines))
    for language in LANGUAGES:
        search = []
        for entry in entries:
            name = words_of(entry["names"][language])
            extra = []
            for keyword in entry["keywords"][language]:
                for word in words_of(keyword):
                    if word not in name and word not in extra:
                        extra.append(word)
            search.append(" ".join(name) + "\t" + " ".join(extra))
        table = emoji_words(language, entries)
        words = [f"{word}\t{table[word]}" for word in sorted(table, key=lambda word: word.encode("utf-8"))]
        sections.append((f"names:{language}", [entry["names"][language] for entry in entries]))
        sections.append((f"search:{language}", search))
        sections.append((f"words:{language}", words))
        if "--words" in sys.argv:
            print(language, " ".join(f"{word}={entries[table[word]]['emoji']}" for word in sorted(table)))

    blobs = [(name, "".join(line + "\n" for line in lines).encode("utf-8")) for name, lines in sections]
    for name, lines in sections:
        if any("\n" in line for line in lines):
            raise SystemExit(f"A line break inside a line of {name}")
    directory = "\t".join(["OWEM1", *(f"{name}:{len(blob)}" for name, blob in blobs)]) + "\n"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(directory.encode("utf-8") + b"".join(blob for _, blob in blobs))

    for identifier, category in categories:
        toned = sum(1 for entry in category if entry["tones"])
        print(f"{identifier}: {len(category)} emoji, {toned} with skin tones")
    print(f"{len(entries)} emoji, {OUT.stat().st_size} bytes → {OUT.relative_to(PLUGIN)}")


if __name__ == "__main__":
    main()

"""Builds the keyboard's bundled lexicon and language model for one language.

    python3 -I tools/build-lexicon.py en
    python3 -I tools/build-lexicon.py de

Reads the corpora `tools/fetch-sources.sh` downloaded into data/.cache (Leipzig Corpora Collection
and Tatoeba; see data/LICENSES.md) and writes ios/Resources/lexicon-<lang>.bin, the file
`TypingLexicon.swift` maps into memory. Deterministic: the same downloads give the same bytes.

File layout (little endian), all offsets from the start of the file:

    header   "OWLX", version u32, wordCount u32, nodeCount u32, pairCount u32, then one u32 offset
             per section in the order below
    strings  wordCount+1 u32 offsets into the blob, then the UTF-8 blob (the words as written)
    unigram  wordCount u8: round(-log10(p) * 25), capped at 255
    cumul    wordCount+1 f32: running sum of p, so a key range's mass is one subtraction
    last     wordCount u16: the last character of each word's key
    nodes    nodeCount x 16 bytes: char u16, childCount u8, termCount u8, firstChild u32,
             wordLo u32, wordHi u32. Node 0 is the root. A node's children are contiguous and
             sorted by char; its words are [wordLo, wordHi), the first termCount of them ending
             exactly here.
    bigram   wordCount+1 u32 offsets, then pairCount u32: next word id << 8 | q, sorted by id,
             q = round(-log10(P(next | previous)) * 25)

Words are sorted by key, then by count, highest first. A key is the word in lower case without
apostrophes, so "dont" finds "don't" and "sie" finds both "sie" and "Sie". Word 0 is the
sentence start, with an empty string.
"""

import bz2
import math
import re
import struct
import sys
import tarfile
from collections import Counter, defaultdict
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
CACHE = PLUGIN / "data/.cache"
OUT = PLUGIN / "ios/Resources"

CONFIG = {
    "en": {
        "letters": "abcdefghijklmnopqrstuvwxyz",
        "leipzig": {"news": "leipzig-eng-news", "web": "leipzig-eng-web", "wiki": "leipzig-eng-wiki"},
        "tatoeba": "tatoeba-eng",
        "single_letter_words": {"a", "i"},
        "max_words": 100_000,
    },
    "de": {
        "letters": "abcdefghijklmnopqrstuvwxyzäöüß",
        "leipzig": {"news": "leipzig-deu-news", "web": "leipzig-deu-web", "wiki": "leipzig-deu-wiki"},
        "tatoeba": "tatoeba-deu",
        "single_letter_words": set(),
        "max_words": 140_000,
    },
}
MIN_COUNT = 12
MIN_PAIR_COUNT = 3
MAX_PAIRS = 1_400_000
TOKEN = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*|\d+")
SENTENCE_BREAK = re.compile(r"[.!?]")
WARNED = set()


def key_of(form):
    return form.lower().replace("'", "")


def sentences(config):
    """(source kind, sentence) for every sentence of every corpus present."""
    for kind, folder in sorted(config["leipzig"].items()):
        path = CACHE / folder / "corpus.tar.gz"
        if not path.exists():
            # The 100K-sentence corpus of the same name: for a quick build while the 1M one
            # downloads. Release lexicons are built from the 1M corpora.
            path = CACHE / f"{folder}-100k" / "corpus.tar.gz"
            if not path.exists():
                print(f"  missing {folder}, skipped", file=sys.stderr)
                continue
            if folder not in WARNED:
                WARNED.add(folder)
                print(f"  {folder}: using the 100K corpus", file=sys.stderr)
        with tarfile.open(path, "r:gz") as archive:
            for member in archive:
                if member.name.endswith("-sentences.txt"):
                    for raw in archive.extractfile(member):
                        yield kind, raw.decode("utf-8", "replace").partition("\t")[2]
    path = CACHE / config["tatoeba"] / "sentences.tsv.bz2"
    if path.exists():
        with bz2.open(path, "rt", encoding="utf-8") as handle:
            for line in handle:
                yield "tatoeba", line.rstrip("\n").split("\t", 2)[-1]
    else:
        print(f"  missing {config['tatoeba']}, skipped", file=sys.stderr)


def tokens(sentence, letters):
    """(form or None, starts a sentence). None stands for a number or a word outside the
    alphabet: it is no word, and no word pair spans it."""
    result = []
    starts, cursor = True, 0
    for match in TOKEN.finditer(sentence):
        if SENTENCE_BREAK.search(sentence, cursor, match.start()):
            starts = True
        cursor = match.end()
        form = match.group().replace("’", "'")
        if form[0].isdigit() or any(c not in letters and c != "'" for c in form.lower()):
            result.append((None, starts))
        else:
            result.append((form, starts))
        starts = False
    return result


def choose_vocabulary(language, config):
    letters = set(config["letters"])
    inside = Counter()   # form -> count away from a sentence start
    initial = Counter()  # form -> count at a sentence start
    web = Counter()      # key -> count in the web corpus
    edited = Counter()   # key -> count in news and Wikipedia
    curated = Counter()  # key -> count in Tatoeba, whose sentences are proofread
    totals = Counter()
    for kind, sentence in sentences(config):
        for form, starts in tokens(sentence, letters):
            if form is None:
                continue
            (initial if starts else inside)[form] += 1
            key = key_of(form)
            # Tatoeba is left out of this comparison: its sentences are too unlike the others.
            if kind == "web":
                web[key] += 1
                totals["web"] += 1
            elif kind != "tatoeba":
                edited[key] += 1
                totals["edited"] += 1
            else:
                curated[key] += 1

    # Grouped by spelling without regard to case: "we're" and "were" share a key in the
    # trie but are words of their own here.
    by_key = defaultdict(Counter)
    for form, count in inside.items():
        by_key[form.lower()][form] += count
    for form in initial:
        by_key[form.lower()]  # a spelling seen only at sentence starts still exists

    # Which spellings of a key are words of their own ("Polish" beside "polish", "Sie"
    # beside "sie"): the ones that hold a real share of the key away from sentence starts.
    forms = {}
    for key, spellings in by_key.items():
        total_inside = sum(spellings.values())
        kept = {}
        for form, count in spellings.items():
            shouted = len(form) > 1 and form.isupper()
            if count >= 5 and count >= 0.1 * total_inside and not (shouted and count < 0.5 * total_inside):
                kept[form] = count
        if not kept:
            best = max(spellings.items(), key=lambda item: (item[1], item[0]))[0] if spellings else None
            kept[best if best and not (len(best) > 1 and best.isupper()) else key] = 0
        # Everything else written with this key (shouting, sentence starts) goes to the
        # spelling it would have mid-sentence.
        dominant = max(kept.items(), key=lambda item: (item[1], item[0]))[0]
        for form, count in spellings.items():
            if form not in kept:
                kept[dominant] += count
        forms[key] = (kept, dominant)
    for form, count in initial.items():
        kept, dominant = forms[form.lower()]
        lowered = form[0].lower() + form[1:]
        if lowered in kept:
            kept[lowered] += count
        elif form in kept:
            kept[form] += count
        else:
            kept[dominant] += count

    counts = {}
    for folded, (kept, _) in forms.items():
        key = key_of(folded)
        if len(key) == 1 and key not in config["single_letter_words"]:
            continue
        if len(key) > 28 or not key:
            continue
        for form, count in kept.items():
            if count >= MIN_COUNT:
                counts[form] = count

    counts = drop_likely_typos(counts, config, web, edited, curated, totals)
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[: config["max_words"]]
    return dict(ranked)


def drop_likely_typos(counts, config, web, edited, curated, totals):
    """Web text carries its typos ("teh", "recieve") often enough to pass MIN_COUNT. A word is
    taken for one when a word one edit away is at least 50 times as common and edited text
    (news, Wikipedia) writes the word under an eighth as often as the web does.

    Two kinds of word look like that and are kept: names and acronyms, which are mostly
    written with a capital ("iOS", "AWS", "Yelp"; a typo rarely is), and everyday words that
    news and Wikipedia have little use for ("yup", "tart", German "dein", "gibst"), which
    proofread Tatoeba sentences do use."""
    if not totals["web"] or not totals["edited"]:
        return counts
    key_counts = Counter()
    for form, count in counts.items():
        key_counts[key_of(form)] += count
    alphabet = config["letters"]
    edited_per_web = totals["edited"] / totals["web"]
    dominant = {}
    for form, count in counts.items():
        key = key_of(form)
        if key not in dominant or count > counts[dominant[key]]:
            dominant[key] = form
    dropped = []
    for key, count in key_counts.items():
        if len(key) < 3:
            continue
        if dominant[key] != dominant[key].lower() or curated[key] >= 2:
            continue
        expected_edited = web[key] * edited_per_web
        if edited[key] >= 3 and edited[key] >= 0.12 * expected_edited:
            continue
        if web[key] < 3:
            continue
        bar = 50 * count
        found = False
        for i in range(len(key) + 1):
            head, tail = key[:i], key[i:]
            variants = [head + c + tail for c in alphabet]
            if tail:
                variants.append(head + tail[1:])
                variants.extend(head + c + tail[1:] for c in alphabet)
            if len(tail) > 1:
                variants.append(head + tail[1] + tail[0] + tail[2:])
            if any(v != key and key_counts.get(v, 0) >= bar for v in variants):
                found = True
                break
        if found:
            dropped.append(key)
    gone = set(dropped)
    print(f"  dropped {len(gone)} likely typos, e.g. {sorted(gone, key=lambda k: -key_counts[k])[:40]}")
    return {form: count for form, count in counts.items() if key_of(form) not in gone}


def count_pairs(config, ids, forms_by_key):
    letters = set(config["letters"])
    pairs = Counter()
    shift = 1 << 20
    for _, sentence in sentences(config):
        previous = 0
        for form, starts in tokens(sentence, letters):
            if starts:
                previous = 0
            if form is None:
                previous = None
                continue
            word = ids.get(form)
            if word is None:
                # A sentence start or shouting: the spelling it has mid-sentence.
                options = forms_by_key.get(key_of(form))
                if options:
                    lowered = form[0].lower() + form[1:]
                    word = ids.get(lowered, options[0])
            if word is not None and previous is not None:
                pairs[previous * shift + word] += 1
            previous = word
    return pairs


def build(language):
    config = CONFIG[language]
    print(f"{language}: choosing the vocabulary")
    counts = choose_vocabulary(language, config)
    total = sum(counts.values())

    ordered = sorted(counts, key=lambda form: (key_of(form), -counts[form], form))
    words = [""] + ordered  # 0 is the sentence start
    ids = {form: index for index, form in enumerate(words) if index}
    keys = [""] + [key_of(form) for form in ordered]
    forms_by_key = defaultdict(list)
    for index in range(1, len(words)):
        forms_by_key[keys[index]].append(index)
    print(f"  {len(ordered)} words, {total} tokens")

    print(f"{language}: counting word pairs")
    pairs = count_pairs(config, ids, forms_by_key)
    kept = [(pair, count) for pair, count in pairs.items() if count >= MIN_PAIR_COUNT]
    kept.sort(key=lambda item: (-item[1], item[0]))
    kept = kept[:MAX_PAIRS]
    shift = 1 << 20
    previous_totals = Counter()
    for pair, count in pairs.items():
        previous_totals[pair // shift] += count
    by_previous = defaultdict(list)
    for pair, count in kept:
        previous, word = divmod(pair, shift)
        q = min(255, round(-math.log10(count / previous_totals[previous]) * 25))
        by_previous[previous].append((word, q))
    print(f"  {len(kept)} pairs kept of {len(pairs)}")

    # Trie over the keys. Words are sorted by key, so each node owns a run of word ids.
    nodes = []  # [char, children (list of node indexes), termCount, lo, hi]

    def make(lo, hi, depth):
        """Fills the children of the node whose words are [lo, hi) and whose key prefix has
        `depth` characters. Returns (termCount, child specs)."""
        term = 0
        while lo + term < hi and len(keys[lo + term]) == depth:
            term += 1
        children = []
        start = lo + term
        while start < hi:
            char = keys[start][depth]
            end = start
            while end < hi and keys[end][depth] == char:
                end += 1
            children.append((char, start, end))
            start = end
        return term, children

    # Breadth first, so every node's children are contiguous.
    nodes.append({"char": "\0", "lo": 1, "hi": len(words), "depth": 0})
    queue = [0]
    while queue:
        next_queue = []
        for index in queue:
            node = nodes[index]
            term, children = make(node["lo"], node["hi"], node["depth"])
            node["term"] = term
            node["first"] = len(nodes)
            node["count"] = len(children)
            for char, lo, hi in children:
                next_queue.append(len(nodes))
                nodes.append({"char": char, "lo": lo, "hi": hi, "depth": node["depth"] + 1})
        queue = next_queue
    print(f"  {len(nodes)} trie nodes")

    blob = bytearray()
    offsets = []
    for form in words:
        offsets.append(len(blob))
        blob += form.encode("utf-8")
    offsets.append(len(blob))
    strings = struct.pack(f"<{len(offsets)}I", *offsets) + bytes(blob)
    strings += b"\0" * (-len(strings) % 4)

    probabilities = [0.0] + [counts[form] / total for form in ordered]
    unigram = bytes(
        [255] + [min(255, round(-math.log10(p) * 25)) for p in probabilities[1:]]
    )
    unigram += b"\0" * (-len(unigram) % 4)
    running, cumulative = 0.0, [0.0]
    for p in probabilities:
        running += p
        cumulative.append(running)
    cumul = struct.pack(f"<{len(cumulative)}f", *cumulative[: len(words) + 1])
    last = struct.pack(f"<{len(words)}H", *[ord(key[-1]) if key else 0 for key in keys])
    last += b"\0" * (-len(last) % 4)

    node_bytes = bytearray()
    for node in nodes:
        node_bytes += struct.pack(
            "<HBBIII", ord(node["char"]), node["count"], min(node["term"], 255), node["first"], node["lo"], node["hi"]
        )

    pair_offsets, pair_values = [], []
    for previous in range(len(words)):
        pair_offsets.append(len(pair_values))
        for word, q in sorted(by_previous.get(previous, ())):
            pair_values.append(word << 8 | q)
    pair_offsets.append(len(pair_values))
    bigram = struct.pack(f"<{len(pair_offsets)}I", *pair_offsets) + struct.pack(f"<{len(pair_values)}I", *pair_values)

    sections = [strings, unigram, cumul, last, bytes(node_bytes), bigram]
    header_size = 4 + 4 * 4 + 4 * len(sections)
    section_offsets, cursor = [], header_size
    for section in sections:
        section_offsets.append(cursor)
        cursor += len(section)
    header = b"OWLX" + struct.pack("<4I", 1, len(words), len(nodes), len(pair_values))
    header += struct.pack(f"<{len(sections)}I", *section_offsets)

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"lexicon-{language}.bin"
    path.write_bytes(header + b"".join(sections))
    print(f"  wrote {path.name}: {path.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    for language in sys.argv[1:] or ["en", "de"]:
        build(language)

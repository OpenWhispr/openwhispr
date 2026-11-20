"""Builds the keyboard benchmark datasets from sources that are independent of the bundled lexicon.

Run with `python3 -I tools/build-benchmarks.py` after `tools/fetch-sources.sh`. Output goes to
tests/benchmarks/. Everything is deterministic (fixed seeds, sorted inputs), so a rebuild from the
same downloads gives the same bytes. The test splits are frozen: their SHA-256 hashes are in
docs/keyboard-iteration-ledger.md, and this script refuses to overwrite a test split that differs.

Sources (see data/LICENSES.md):
- Universal Dependencies English-EWT and German-GSD (CC BY-SA 4.0): sentences.
- Wikipedia "Lists of common misspellings/For machines" and "Liste von Tippfehlern" (CC BY-SA 4.0).
- OpenSubtitles 2018 frequency lists from hermitdave/FrequencyWords (CC BY-SA 4.0): swipe words.
"""

import hashlib
import random
import re
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
CACHE = PLUGIN / "data/.cache"
OUT = PLUGIN / "tests/benchmarks"

LETTERS = {"en": "abcdefghijklmnopqrstuvwxyz", "de": "abcdefghijklmnopqrstuvwxyzäöüß"}

# Key rows per (language, layout), as the keyboard draws them. German QWERTZ has umlaut keys;
# ß is typed by holding s, so it has no key of its own.
ROWS = {
    ("en", "qwerty"): ["qwertyuiop", "asdfghjkl", "zxcvbnm"],
    ("en", "qwertz"): ["qwertzuiop", "asdfghjkl", "yxcvbnm"],
    ("de", "qwertz"): ["qwertzuiopü", "asdfghjklöä", "yxcvbnm"],
    ("de", "qwerty"): ["qwertyuiopü", "asdfghjklöä", "zxcvbnm"],
}


def key_centres(rows):
    """Key centres in key widths: every row is centred under the widest one."""
    widest = max(len(row) for row in rows)
    centres = {}
    for y, row in enumerate(rows):
        offset = (widest - len(row)) / 2
        for x, letter in enumerate(row):
            centres[letter] = (offset + x + 0.5, y + 0.5)
    return centres


def neighbours(rows):
    centres = key_centres(rows)
    result = {}
    for a, (ax, ay) in centres.items():
        near = []
        for b, (bx, by) in centres.items():
            if a == b:
                continue
            dx, dy = abs(ax - bx), abs(ay - by)
            if (dy == 0 and dx <= 1.01) or (dy == 1 and dx <= 0.8):
                near.append(b)
        result[a] = sorted(near)
    return result


def write(name, lines, frozen):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    data = ("\n".join(lines) + "\n").encode("utf-8")
    if frozen and path.exists() and path.read_bytes() != data:
        sys.exit(f"{name} is a frozen test split and would change; refusing to overwrite it.")
    path.write_bytes(data)
    print(f"{name}: {len(lines)} lines, sha256 {hashlib.sha256(data).hexdigest()}")


# --- Sentences -------------------------------------------------------------------------------


def ud_sentences(folder, split):
    """Sentence texts, leaving out sentences the treebank marks as holding a typo."""
    sentences, text, has_typo = [], None, False
    for line in (CACHE / folder / f"{split}.conllu").read_text(encoding="utf-8").splitlines():
        if line.startswith("# text = "):
            text = line[len("# text = "):].strip()
        elif not line:
            if text and not has_typo:
                sentences.append(re.sub(r"\s+", " ", text))
            text, has_typo = None, False
        elif not line.startswith("#"):
            columns = line.split("\t")
            if len(columns) > 9 and ("Typo=Yes" in columns[5] or "CorrectForm=" in columns[9]):
                has_typo = True
    return sentences


# --- Real misspellings -----------------------------------------------------------------------


def split_of(key):
    return "dev" if hashlib.sha1(key.encode("utf-8")).digest()[0] % 2 == 0 else "test"


def plain_word(word, language):
    return bool(word) and all(c in LETTERS[language] or c == "'" for c in word.lower())


def english_misspellings():
    pairs = {}
    for line in (CACHE / "wikipedia-misspellings-en/list.txt").read_text(encoding="utf-8").splitlines():
        if "->" not in line or line.startswith(("=", "<")):
            continue
        wrong, right = (part.strip() for part in line.split("->", 1))
        # One correction only: with several, the list itself can't say which was meant.
        if "," in right or not plain_word(wrong, "en") or not plain_word(right, "en"):
            continue
        if wrong.lower() != right.lower():
            pairs[wrong] = right
    return pairs


def german_misspellings():
    pairs = {}
    pattern = re.compile(r"\{\{Tippfehler\|([^|{}]+)\|([^|{}]+)\}\}(.*)")
    for path in sorted((CACHE / "wikipedia-tippfehler-de").glob("*.txt")):
        for line in path.read_text(encoding="utf-8").splitlines():
            match = pattern.search(line)
            if not match:
                continue
            wrong, right, rest = match.group(1).strip(), match.group(2).strip(), match.group(3)
            # "zeitgenösisch*": a stem that stands for its inflections; the stem itself is a pair.
            if wrong.endswith("*") and right.endswith("*"):
                wrong, right = wrong[:-1], right[:-1]
            # "(außer bei …)", "(wenn …)": only wrong in some contexts.
            if rest.lstrip().startswith("''("):
                continue
            if "," in right or not plain_word(wrong, "de") or not plain_word(right, "de"):
                continue
            if wrong.lower() != right.lower():
                pairs[wrong] = right
    return pairs


# --- Synthetic near-miss typos ---------------------------------------------------------------

WORD = re.compile(r"^[\"'(\[„“‚‘]*([^\W\d_]+(?:'[^\W\d_]+)?)[\"').,!?:;\]“”’‘…]*$")


def typo_for(word, language, near, rng):
    """One slip of the kind a thumb makes: a neighbouring key, two letters swapped, a letter
    missed, or a neighbouring key hit as well. Case follows the letter it replaces."""
    letters = list(word)
    positions = [i for i, c in enumerate(letters) if c.lower() in near]
    if not positions:
        return None
    roll = rng.random()
    i = rng.choice(positions)
    lower = letters[i].lower()

    def cased(replacement, like):
        return replacement.upper() if like.isupper() else replacement

    if roll < 0.60:
        letters[i] = cased(rng.choice(near[lower]), letters[i])
    elif roll < 0.75:
        swappable = [j for j in range(len(letters) - 1) if letters[j].lower() != letters[j + 1].lower()
                     and letters[j].isalpha() and letters[j + 1].isalpha()]
        if not swappable:
            return None
        j = rng.choice(swappable)
        first, second = letters[j], letters[j + 1]
        letters[j], letters[j + 1] = cased(second.lower(), first), cased(first.lower(), second)
    elif roll < 0.87:
        # The first letter is rarely the one missed.
        inner = [j for j in positions if j > 0]
        if not inner or len(letters) < 4:
            return None
        del letters[rng.choice(inner)]
    else:
        letters.insert(i + 1, rng.choice(near[lower]))
    typo = "".join(letters)
    return typo if typo.lower() != word.lower() else None


def typos(sentences, language, layout, seed, count):
    near = neighbours(ROWS[(language, layout)])
    rng = random.Random(seed)
    candidates = []
    for sentence in sentences:
        tokens = sentence.split(" ")
        for index, token in enumerate(tokens):
            match = WORD.match(token)
            if not match:
                continue
            word = match.group(1)
            if len(word) < 3 or not plain_word(word, language):
                continue
            # All-capitals tokens are mostly acronyms, which no keyboard corrects.
            if len(word) > 1 and word.isupper():
                continue
            candidates.append((" ".join(tokens[max(0, index - 3):index]), word))
    rng.shuffle(candidates)
    rows = []
    for context, word in candidates:
        typo = typo_for(word, language, near, rng)
        if typo:
            rows.append(f"{context}\t{typo}\t{word}")
        if len(rows) == count:
            break
    return rows


# --- Swipe words -----------------------------------------------------------------------------


def swipe_words(language, count=10000):
    rows = []
    for line in (CACHE / f"opensubtitles-freq/{language}_50k.txt").read_text(encoding="utf-8").splitlines():
        word, _, frequency = line.partition(" ")
        # A swipe needs two keys; apostrophes are skipped by the path ("dont" → "don't").
        if len(word.replace("'", "")) < 2 or not plain_word(word, language):
            continue
        if word.startswith("'") or word.endswith("'"):
            continue
        rows.append(f"{word}\t{frequency}")
        if len(rows) == count:
            break
    return rows


def main():
    for language, folder, layout in (("en", "ud-en-ewt", "qwerty"), ("de", "ud-de-gsd", "qwertz")):
        dev = ud_sentences(folder, "dev")
        test = ud_sentences(folder, "test")
        write(f"sentences.{language}.dev.txt", dev, frozen=False)
        write(f"sentences.{language}.test.txt", test, frozen=True)
        write(f"typos.{language}-{layout}.dev.tsv", typos(dev, language, layout, 1101, 5000), frozen=False)
        write(f"typos.{language}-{layout}.test.tsv", typos(test, language, layout, 2202, 5000), frozen=True)

        pairs = english_misspellings() if language == "en" else german_misspellings()
        for split in ("dev", "test"):
            rows = [f"{wrong}\t{right}" for wrong, right in sorted(pairs.items()) if split_of(wrong) == split]
            write(f"misspellings.{language}.{split}.tsv", rows, frozen=split == "test")
        write(f"swipe-words.{language}.tsv", swipe_words(language), frozen=True)


if __name__ == "__main__":
    main()

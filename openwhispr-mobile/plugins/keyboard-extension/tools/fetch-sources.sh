#!/bin/sh
# Downloads the raw corpora the lexicon builder and the benchmark builders read.
# Each download lands in its own directory under data/.cache (git-ignored). Nothing here is executed.
set -eu
cache="$(cd "$(dirname "$0")/.." && pwd)/data/.cache"
fetch() { # name url file
  mkdir -p "$cache/$1"
  if [ ! -s "$cache/$1/$3" ]; then
    curl -fsSL --retry 3 -A 'openwhispr-keyboard-data/1.0' -o "$cache/$1/$3.part" "$2" && mv "$cache/$1/$3.part" "$cache/$1/$3"
  fi
}
L=https://downloads.wortschatz-leipzig.de/corpora
# Bundled lexicon sources (Leipzig Corpora Collection, CC BY 4.0; Tatoeba, CC BY 2.0 FR)
fetch leipzig-eng-news "$L/eng_news_2020_1M.tar.gz" corpus.tar.gz
fetch leipzig-eng-web "$L/eng-com_web-public_2018_1M.tar.gz" corpus.tar.gz
fetch leipzig-eng-wiki "$L/eng_wikipedia_2016_1M.tar.gz" corpus.tar.gz
fetch leipzig-deu-news "$L/deu_news_2020_1M.tar.gz" corpus.tar.gz
fetch leipzig-deu-web "$L/deu-de_web-public_2019_1M.tar.gz" corpus.tar.gz
fetch leipzig-deu-wiki "$L/deu_wikipedia_2021_1M.tar.gz" corpus.tar.gz
fetch tatoeba-eng https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2 sentences.tsv.bz2
fetch tatoeba-deu https://downloads.tatoeba.org/exports/per_language/deu/deu_sentences.tsv.bz2 sentences.tsv.bz2
# Benchmark sources (independent of the bundle)
U=https://raw.githubusercontent.com/UniversalDependencies
for s in train dev test; do
  fetch ud-en-ewt "$U/UD_English-EWT/master/en_ewt-ud-$s.conllu" "$s.conllu"
  fetch ud-de-gsd "$U/UD_German-GSD/master/de_gsd-ud-$s.conllu" "$s.conllu"
done
fetch ud-en-ewt "$U/UD_English-EWT/master/LICENSE.txt" LICENSE.txt
fetch ud-de-gsd "$U/UD_German-GSD/master/LICENSE.txt" LICENSE.txt
H=https://raw.githubusercontent.com/hermitdave/FrequencyWords/master
fetch opensubtitles-freq "$H/content/2018/en/en_50k.txt" en_50k.txt
fetch opensubtitles-freq "$H/content/2018/de/de_50k.txt" de_50k.txt
fetch opensubtitles-freq "$H/LICENSE" LICENSE
fetch wikipedia-misspellings-en "https://en.wikipedia.org/wiki/Wikipedia:Lists_of_common_misspellings/For_machines?action=raw" list.txt
# Emoji (Unicode License v3)
C=https://raw.githubusercontent.com/unicode-org/cldr/main/common
for l in en de; do
  fetch cldr "$C/annotations/$l.xml" "annotations-$l.xml"
  fetch cldr "$C/annotationsDerived/$l.xml" "annotationsDerived-$l.xml"
done
fetch emoji https://unicode.org/Public/emoji/latest/emoji-test.txt emoji-test.txt

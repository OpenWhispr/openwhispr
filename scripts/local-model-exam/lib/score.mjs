// Text normalisation and error rates. Normalisation follows the idea of
// Whisper's BasicTextNormalizer (lower-case, drop bracketed asides, turn
// punctuation and symbols into spaces) and is applied to every language alike.
// Languages written without spaces are scored by characters, or every model
// would look 100% wrong on them. Korean has spaces, but its standard measure is
// also the character error rate, so a model that drops the spaces is not
// scored as having every word wrong.
const CHAR_LANGUAGES = new Set(["zh", "ja", "th", "yue", "ko"]);

export function baseLanguage(code) {
  return String(code || "")
    .split(/[-_]/)[0]
    .toLowerCase();
}

export function normalizeTranscript(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[<[][^>\]]*[>\]]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoringUnit(language) {
  return CHAR_LANGUAGES.has(baseLanguage(language)) ? "char" : "word";
}

const SMALL = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const ORDINALS = {
  first: "1",
  third: "3",
  fourth: "4",
  fifth: "5",
  sixth: "6",
  seventh: "7",
  eighth: "8",
  ninth: "9",
  tenth: "10",
  eleventh: "11",
  twelfth: "12",
  thirteenth: "13",
  fifteenth: "15",
  twentieth: "20",
  thirtieth: "30",
};
const isNumberWord = (w) => w in SMALL || w in TENS || w in SCALES;
// Hesitations Whisper's English normaliser also removes before scoring.
const ENGLISH_FILLERS = new Set(["um", "umm", "uh", "uhm", "hmm", "mm", "mhm", "er", "erm", "ah"]);

// English only: spelled numbers become digits and neighbouring digit groups
// merge, so "three thirty", "3.30" and "330" all score as the same token.
// Symmetric, so it never favours one model's number style over another's.
export function canonicalEnglishNumbers(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isNumberWord(tokens[i])) {
      const w = tokens[i];
      if (w === "percent") {
        i++;
        continue;
      }
      out.push(ORDINALS[w] ?? w.replace(/^(\d+)(st|nd|rd|th)$/, "$1"));
      i++;
      continue;
    }
    let total = 0;
    let current = 0;
    let started = false;
    let last = null;
    const flush = () => {
      if (started) out.push(String(total + current));
      total = 0;
      current = 0;
      started = false;
      last = null;
    };
    while (i < tokens.length) {
      const w = tokens[i];
      if (w === "and" && last === "scale" && i + 1 < tokens.length && isNumberWord(tokens[i + 1])) {
        i++;
        continue;
      }
      if (w in SMALL) {
        if (last === "small" || (last === "tens" && (current % 10 !== 0 || SMALL[w] >= 10)))
          flush();
        current += SMALL[w];
        started = true;
        last = "small";
      } else if (w in TENS) {
        if (last === "small" || last === "tens") flush();
        current += TENS[w];
        started = true;
        last = "tens";
      } else if (w in SCALES) {
        if (!started) {
          current = 1;
          started = true;
        }
        if (SCALES[w] === 100) current *= 100;
        else {
          total += current * SCALES[w];
          current = 0;
        }
        last = "scale";
      } else break;
      i++;
    }
    flush();
  }
  const merged = [];
  for (const t of out) {
    if (/^\d+$/.test(t) && merged.length && /^\d+$/.test(merged[merged.length - 1]))
      merged[merged.length - 1] += t;
    else merged.push(t);
  }
  return merged;
}

export function toUnits(text, language) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return [];
  if (scoringUnit(language) === "char") return [...normalized.replace(/\s+/g, "")];
  const tokens = normalized.split(" ");
  if (baseLanguage(language) !== "en") return tokens;
  return canonicalEnglishNumbers(tokens.filter((t) => !ENGLISH_FILLERS.has(t)));
}

// Levenshtein alignment that keeps substitution, deletion and insertion counts.
export function editCounts(reference, hypothesis) {
  const cols = hypothesis.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => ({ cost: j, s: 0, d: 0, i: j }));
  for (let r = 1; r <= reference.length; r++) {
    const cur = [{ cost: r, s: 0, d: r, i: 0 }];
    for (let c = 1; c < cols; c++) {
      if (reference[r - 1] === hypothesis[c - 1]) {
        cur.push({ ...prev[c - 1] });
        continue;
      }
      const sub = prev[c - 1].cost + 1;
      const del = prev[c].cost + 1;
      const ins = cur[c - 1].cost + 1;
      if (sub <= del && sub <= ins) cur.push({ ...prev[c - 1], cost: sub, s: prev[c - 1].s + 1 });
      else if (del <= ins) cur.push({ ...prev[c], cost: del, d: prev[c].d + 1 });
      else cur.push({ ...cur[c - 1], cost: ins, i: cur[c - 1].i + 1 });
    }
    prev = cur;
  }
  const last = prev[cols - 1];
  return { substitutions: last.s, deletions: last.d, insertions: last.i };
}

// Words a model wrote where the audio had no speech: after the last spoken
// word, or in a pause between spoken parts. A mistake inside the speech (a long
// word heard as two) is a recognition error, not a made-up word, so an extra
// word only counts when the spoken word before it was recognised exactly.
export function insertionsOutsideSpeech(referenceParts, hypothesis, language) {
  const parts = referenceParts.map((p) => toUnits(p, language));
  const ref = parts.flat();
  const hyp = toUnits(hypothesis, language);
  const gaps = new Set();
  let end = 0;
  for (const part of parts) gaps.add((end += part.length));
  const R = ref.length;
  const H = hyp.length;
  const cost = Array.from({ length: R + 1 }, (_, r) =>
    Array.from({ length: H + 1 }, (_, h) => (r === 0 ? h : h === 0 ? r : 0))
  );
  for (let r = 1; r <= R; r++) {
    for (let h = 1; h <= H; h++) {
      cost[r][h] = Math.min(
        cost[r - 1][h - 1] + (ref[r - 1] === hyp[h - 1] ? 0 : 1),
        cost[r - 1][h] + 1,
        cost[r][h - 1] + 1
      );
    }
  }
  // Walk back from the end, preferring an exact match, then an extra word.
  const ops = [];
  for (let r = R, h = H; r > 0 || h > 0;) {
    if (r > 0 && h > 0 && ref[r - 1] === hyp[h - 1] && cost[r][h] === cost[r - 1][h - 1])
      ops.push({ op: "match", r: --r, h: --h });
    else if (h > 0 && cost[r][h] === cost[r][h - 1] + 1)
      ops.push({ op: "insert", after: r, h: --h });
    else if (r > 0 && h > 0 && cost[r][h] === cost[r - 1][h - 1] + 1)
      ops.push({ op: "substitute", r: --r, h: --h });
    else ops.push({ op: "delete", r: --r });
  }
  ops.reverse();
  let count = 0;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op !== "insert" || !gaps.has(ops[i].after)) continue;
    // The nearest aligned spoken word before this extra word must be exact.
    let k = i - 1;
    while (k >= 0 && ops[k].op === "insert") k--;
    if (k >= 0 && ops[k].op === "match") count++;
  }
  return count;
}

export function errorCounts(reference, hypothesis, language) {
  const ref = toUnits(reference, language);
  const hyp = toUnits(hypothesis, language);
  return { ...editCounts(ref, hyp), referenceUnits: ref.length, unit: scoringUnit(language) };
}

export function errorsPer100(counts) {
  if (!counts.referenceUnits) return null;
  return (
    (100 * (counts.substitutions + counts.deletions + counts.insertions)) / counts.referenceUnits
  );
}

// Pools counts across clips so long clips weigh more than short ones.
export function pooledErrorsPer100(countsList) {
  const total = { substitutions: 0, deletions: 0, insertions: 0, referenceUnits: 0 };
  for (const c of countsList) {
    total.substitutions += c.substitutions;
    total.deletions += c.deletions;
    total.insertions += c.insertions;
    total.referenceUnits += c.referenceUnits;
  }
  return errorsPer100(total);
}

// Anything at all in the output of a silence clip counts as made-up words.
export function addedWords(text) {
  const normalized = normalizeTranscript(text);
  return normalized ? normalized.split(" ").length : 0;
}

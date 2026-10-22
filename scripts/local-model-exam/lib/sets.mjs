// Test material: public FLEURS read speech (25 European languages), dictation-style
// sentences spoken by macOS's built-in voices (synthetic, no real person's voice;
// made with `say` on a Mac, copied as cached clips elsewhere), English
// dictations built to set lengths, and a
// silence-and-pause set. Everything is cached under scripts/local-model-exam/.cache/.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { concatPcm, fileToPcm, noisePcm, secondsOf, silencePcm } from "./audio.mjs";
import { normalizeTranscript } from "./score.mjs";

const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".cache");
const FLEURS_DATASET = "hf-audio/open-asr-leaderboard-multilingual-datasets";

export const FLEURS_LANGUAGES = [
  "en",
  "de",
  "es",
  "fr",
  "it",
  "pt",
  "nl",
  "pl",
  "ru",
  "uk",
  "bg",
  "cs",
  "da",
  "el",
  "et",
  "fi",
  "hr",
  "hu",
  "lt",
  "lv",
  "mt",
  "ro",
  "sk",
  "sl",
  "sv",
];

export const GROUP_OF = Object.fromEntries([
  ...["en"].map((l) => [l, "english"]),
  ...["es", "fr", "de", "it", "pt", "nl", "pl", "ru", "uk"].map((l) => [l, "major-european"]),
  ...[
    "bg",
    "cs",
    "da",
    "el",
    "et",
    "fi",
    "hr",
    "hu",
    "lt",
    "lv",
    "mt",
    "ro",
    "sk",
    "sl",
    "sv",
    "no",
  ].map((l) => [l, "other-european"]),
  ...["ja", "zh", "ko", "hi", "ar", "he", "tr", "vi", "id", "th"].map((l) => [l, "asian-other"]),
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries rate limits and dropped connections (a timeout mid-download is not
// the clip's fault); gives up after `attempts`.
async function fetchWithRetry(url, read, attempts = 7) {
  for (let i = 1; ; i++) {
    let status = "network";
    try {
      const res = await fetch(url);
      status = res.status;
      if (res.ok) return await read(res);
    } catch (error) {
      if (i >= attempts) throw error;
    }
    if (i >= attempts) throw new Error(`${status} ${url}`);
    await sleep((status === 429 ? 10000 : 2000) * i);
  }
}

const fetchJson = (url) => fetchWithRetry(url, (res) => res.json());

async function downloadToPcm(url, scratchName) {
  const audio = await fetchWithRetry(url, async (res) => Buffer.from(await res.arrayBuffer()));
  const tmp = path.join(os.tmpdir(), scratchName);
  fs.writeFileSync(tmp, audio);
  try {
    return await fileToPcm(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const wordsIn = (text) => normalizeTranscript(text).split(" ").filter(Boolean).length;

const MIN_CLIP_RMS = 0.01;
function rmsOf(pcm) {
  let sumSq = 0;
  const n = pcm.length / 2;
  for (let i = 0; i < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i) / 32767;
    sumSq += v * v;
  }
  return n ? Math.sqrt(sumSq / n) : 0;
}

// Clips from the FLEURS test split in a few batches of consecutive rows spread
// across the split (one request per batch keeps under the server's rate
// limit), cached as raw PCM + JSON.
export async function loadFleurs(language, count) {
  const dir = path.join(CACHE, "fleurs", language);
  fs.mkdirSync(dir, { recursive: true });
  const config = `fleurs_${language}`;
  const base = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(FLEURS_DATASET)}&config=${config}&split=test`;
  const indexPath = path.join(dir, `index-${count}.json`);
  let offsets;
  if (fs.existsSync(indexPath)) {
    offsets = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } else {
    const first = await fetchJson(`${base}&offset=0&length=1`);
    const total = first.num_rows_total;
    // About half of FLEURS takes are recorded far below any real microphone
    // level (rms ~0.0005); the app's own quietness check rightly drops those,
    // so they say nothing about a model. Keep takes at a usable level.
    const perBatch = 10;
    const batches = Math.max(2, Math.ceil((count * 2.5) / perBatch));
    offsets = [];
    for (let b = 0; b < batches && offsets.length < count; b++) {
      const start = Math.floor((b * total) / batches);
      const page = await fetchJson(`${base}&offset=${start}&length=${perBatch}`);
      for (const [k, entry] of page.rows.entries()) {
        if (offsets.length >= count) break;
        const offset = start + k;
        const stem = path.join(dir, String(offset));
        if (!fs.existsSync(`${stem}.json`)) {
          const pcm = await downloadToPcm(
            entry.row.audio[0].src,
            `fleurs-${language}-${offset}.wav`
          );
          fs.writeFileSync(`${stem}.pcm`, pcm);
          fs.writeFileSync(
            `${stem}.json`,
            JSON.stringify({ reference: entry.row.text, file: entry.row.file_name })
          );
        }
        if (rmsOf(fs.readFileSync(`${stem}.pcm`)) >= MIN_CLIP_RMS) offsets.push(offset);
      }
      await sleep(1500);
    }
    fs.writeFileSync(indexPath, JSON.stringify(offsets));
  }
  const clips = [];
  for (const offset of offsets) {
    const stem = path.join(dir, String(offset));
    const meta = JSON.parse(fs.readFileSync(`${stem}.json`, "utf8"));
    const pcm = fs.readFileSync(`${stem}.pcm`);
    clips.push({
      id: `fleurs-${language}-${offset}`,
      set: "fleurs",
      language,
      group: GROUP_OF[language],
      reference: meta.reference,
      pcm,
      seconds: secondsOf(pcm),
      words: wordsIn(meta.reference),
    });
  }
  return clips;
}

const VOICES = {
  en: "Samantha",
  ja: "Kyoko",
  zh: "Tingting",
  ko: "Yuna",
  hi: "Lekha",
  ar: "Majed",
  he: "Carmit",
  tr: "Yelda",
  vi: "Linh",
  id: "Damayanti",
  th: "Kanya",
};

// [[slnc N]] is a spoken pause; it is removed from the reference text.
export const DICTATION_SENTENCES = {
  en: [
    "Um, can you send the quarterly report to Marcus Chen before Friday?",
    "Book a table for four at seven thirty tonight under the name Okafor.",
    "The API returns an error when the access token has expired, so we refresh it first.",
    "Please move my three o'clock with Siobhan to Thursday morning.",
    "So, uh, the deployment failed because the Kubernetes pod ran out of memory.",
    "Remind me to call Doctor Patel about the prescription renewal next week.",
    "Our revenue grew by twelve percent compared to the same quarter last year.",
    "Add milk, eggs, sourdough bread and two avocados to the shopping list.",
    "I think we should, [[slnc 1500]] push the launch back by about two weeks.",
    "Send a Slack message to the design channel saying the new mockups are ready for review.",
    "Her flight lands at Heathrow at nine fifteen, terminal five.",
    "Let's schedule the retrospective for the last Friday of November.",
  ],
  ja: [
    "明日の会議は午後に変更になりました。",
    "田中さんに資料を送ってください。",
    "週末に家族と京都へ旅行に行きます。",
    "この報告書を金曜日までに確認してください。",
    "新しいプロジェクトの予算について話し合いましょう。",
    "駅の近くで美味しいラーメン屋を見つけました。",
  ],
  zh: [
    "请把这份报告发给王经理。",
    "明天下午的会议改到星期四了。",
    "我们需要讨论新产品的市场计划。",
    "周末我想和朋友一起去爬山。",
    "请提醒我下周给医生打电话。",
    "这个项目的预算还需要再确认一下。",
  ],
  ko: [
    "내일 회의는 오후로 변경되었습니다.",
    "김민수 씨에게 보고서를 보내 주세요.",
    "주말에 가족과 함께 부산에 갈 예정입니다.",
    "이 문서를 금요일까지 검토해 주세요.",
    "새로운 프로젝트 예산에 대해 이야기합시다.",
    "회사 근처에 맛있는 식당이 생겼어요.",
  ],
  hi: [
    "कृपया यह रिपोर्ट शर्मा जी को भेज दीजिए।",
    "कल की बैठक दोपहर तक टाल दी गई है।",
    "हमें नए उत्पाद की योजना पर बात करनी चाहिए।",
    "मुझे अगले हफ्ते डॉक्टर को फ़ोन करना याद दिलाना।",
    "सप्ताहांत पर हम परिवार के साथ जयपुर जाएंगे।",
    "इस परियोजना का बजट फिर से जांचना होगा।",
  ],
  ar: [
    "من فضلك أرسل هذا التقرير إلى السيد أحمد.",
    "تم تأجيل اجتماع الغد إلى فترة ما بعد الظهر.",
    "نحتاج إلى مناقشة خطة المنتج الجديد.",
    "ذكرني بالاتصال بالطبيب الأسبوع القادم.",
    "سنسافر مع العائلة إلى الإسكندرية في عطلة نهاية الأسبوع.",
    "يجب مراجعة ميزانية المشروع مرة أخرى.",
  ],
  he: [
    "בבקשה שלח את הדוח הזה לדני.",
    "הפגישה של מחר נדחתה לאחר הצהריים.",
    "אנחנו צריכים לדבר על התוכנית של המוצר החדש.",
    "תזכיר לי להתקשר לרופא בשבוע הבא.",
    "בסוף השבוע ניסע עם המשפחה לחיפה.",
    "צריך לבדוק שוב את התקציב של הפרויקט.",
  ],
  tr: [
    "Lütfen bu raporu Ahmet Bey'e gönder.",
    "Yarınki toplantı öğleden sonraya ertelendi.",
    "Yeni ürünün pazarlama planını konuşmamız gerekiyor.",
    "Gelecek hafta doktoru aramamı hatırlat.",
    "Hafta sonu ailemle birlikte İzmir'e gideceğiz.",
    "Projenin bütçesini tekrar kontrol etmemiz lazım.",
  ],
  vi: [
    "Vui lòng gửi báo cáo này cho anh Minh.",
    "Cuộc họp ngày mai đã được dời sang buổi chiều.",
    "Chúng ta cần thảo luận về kế hoạch sản phẩm mới.",
    "Nhắc tôi gọi điện cho bác sĩ vào tuần sau.",
    "Cuối tuần này gia đình tôi sẽ đi Đà Nẵng.",
    "Ngân sách của dự án cần được kiểm tra lại.",
  ],
  id: [
    "Tolong kirim laporan ini ke Pak Budi.",
    "Rapat besok dipindahkan ke sore hari.",
    "Kita perlu membahas rencana produk yang baru.",
    "Ingatkan saya untuk menelepon dokter minggu depan.",
    "Akhir pekan ini kami akan pergi ke Bandung bersama keluarga.",
    "Anggaran proyek ini perlu diperiksa lagi.",
  ],
  th: [
    "กรุณาส่งรายงานนี้ให้คุณสมชาย",
    "การประชุมพรุ่งนี้เลื่อนไปเป็นช่วงบ่าย",
    "เราต้องคุยเรื่องแผนของผลิตภัณฑ์ใหม่",
    "ช่วยเตือนให้ฉันโทรหาหมอสัปดาห์หน้า",
    "สุดสัปดาห์นี้เราจะไปเชียงใหม่กับครอบครัว",
    "ต้องตรวจสอบงบประมาณของโครงการอีกครั้ง",
  ],
};

export async function loadSynthetic(language) {
  const dir = path.join(CACHE, "tts", language);
  fs.mkdirSync(dir, { recursive: true });
  return Promise.all(
    DICTATION_SENTENCES[language].map(async (text, index) => {
      const stem = path.join(dir, String(index));
      if (!fs.existsSync(`${stem}.pcm`)) {
        if (process.platform !== "darwin") {
          throw new Error(
            `${stem}.pcm is missing. The synthetic voices are made with macOS's say, so run ` +
              "prefetch.mjs on a Mac and copy its .cache/tts folder to this machine."
          );
        }
        const aiff = path.join(os.tmpdir(), `ow-exam-tts-${language}-${index}.aiff`);
        execFileSync("say", ["-v", VOICES[language], "-o", aiff, text]);
        fs.writeFileSync(`${stem}.pcm`, await fileToPcm(aiff));
        fs.rmSync(aiff, { force: true });
      }
      const reference = text
        .replace(/\[\[[^\]]*\]\]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const pcm = fs.readFileSync(`${stem}.pcm`);
      return {
        id: `tts-${language}-${index}`,
        set: "synthetic",
        language,
        group: GROUP_OF[language],
        reference,
        pcm,
        seconds: secondsOf(pcm),
        words: wordsIn(reference),
      };
    })
  );
}

// English dictations of about 15, 60, 250 and 600 words, joined from FLEURS
// utterances with 400 ms gaps, as in a real run-on dictation.
export function buildLengths(englishClips, targets = [15, 60, 250, 600]) {
  const sorted = [...englishClips].sort((a, b) => a.words - b.words);
  return targets.map((target) => {
    const parts = [];
    let words = 0;
    if (target <= 20) {
      const clip = sorted.reduce((best, c) =>
        Math.abs(c.words - target) < Math.abs(best.words - target) ? c : best
      );
      parts.push(clip);
      words = clip.words;
    } else {
      for (const clip of englishClips) {
        if (words >= target) break;
        parts.push(clip);
        words += clip.words;
      }
    }
    const pcm = concatPcm(
      parts.map((p) => p.pcm),
      0.4
    );
    return {
      id: `length-${target}`,
      set: "length",
      language: "en",
      group: "english",
      targetWords: target,
      reference: parts.map((p) => p.reference).join(" "),
      pcm,
      seconds: secondsOf(pcm),
      words,
    };
  });
}

// Silence and pauses. Pure silence and quiet noise never reach a model in the
// shipped app (the speech gate drops them), but trailing silence after speech
// and long pauses mid-sentence do.
export function buildSilenceSet(byLanguage) {
  const clips = [
    { id: "silence-5s", pcm: silencePcm(5) },
    { id: "silence-10s", pcm: silencePcm(10) },
    { id: "silence-30s", pcm: silencePcm(30) },
    { id: "white-50dbfs-5s", pcm: noisePcm(5, -50, "white", 11) },
    { id: "white-40dbfs-5s", pcm: noisePcm(5, -40, "white", 12) },
    { id: "pink-50dbfs-5s", pcm: noisePcm(5, -50, "pink", 13) },
    { id: "pink-40dbfs-5s", pcm: noisePcm(5, -40, "pink", 14) },
  ].map((c) => ({ ...c, kind: "no-speech", language: "en", reference: "" }));
  for (const language of ["en", "ru", "es", "de", "ja"]) {
    const clip = byLanguage[language]?.[0];
    if (!clip) continue;
    clips.push({
      id: `trailing-silence-${language}`,
      kind: "trailing-silence",
      language,
      reference: clip.reference,
      referenceParts: [clip.reference],
      pcm: concatPcm([clip.pcm, silencePcm(5)]),
    });
  }
  const [a, b] = byLanguage.en || [];
  if (a && b) {
    clips.push({
      id: "mid-pause-en",
      kind: "mid-pause",
      language: "en",
      reference: `${a.reference} ${b.reference}`,
      referenceParts: [a.reference, b.reference],
      pcm: concatPcm([a.pcm, b.pcm], 4),
    });
    clips.push({
      id: "speech-then-noise-en",
      kind: "trailing-noise",
      language: "en",
      reference: a.reference,
      referenceParts: [a.reference],
      pcm: concatPcm([a.pcm, noisePcm(8, -50, "pink", 21)]),
    });
  }
  return clips.map((c) => ({ ...c, group: GROUP_OF[c.language], seconds: secondsOf(c.pcm) }));
}

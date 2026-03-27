#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  buildDictionaryPrompt,
  createDictionaryEntriesFromWords,
  dedupeDictionaryEntries,
} = require("../src/helpers/dictionaryEntries");

try {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
} catch {}

const DEFAULT_MANIFEST_PATH = path.resolve(
  __dirname,
  "..",
  "validation",
  "dictionary-validation.openai.json"
);

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? argv[i + 1];
    if (inlineValue === undefined) i += 1;
    args[key] = value;
  }

  return args;
}

function printHelp() {
  console.log(`Dictionary validation runner

Usage:
  node scripts/validate-dictionary-fixtures.js [--manifest path] [--api-key key] [--base-url url] [--model model]

Manifest format:
  {
    "name": "OpenWhispr dictionary validation",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini-transcribe",
    "language": "en",
    "useLiveDictionary": true,
    "dictionaryTerms": ["OpenWhispr", "OpenClaw"],
    "cases": [
      {
        "name": "OpenWhispr product name",
        "transcriptionId": 1174,
        "expectedTerms": ["OpenWhispr"]
      }
    ]
  }
`);
}

function expandHome(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function readManifest(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getDefaultUserDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "open-whispr");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "open-whispr");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "open-whispr");
}

function querySqliteJson(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim();
  return output ? JSON.parse(output) : [];
}

function loadLiveDictionaryEntries(dbPath) {
  const rows = querySqliteJson(
    dbPath,
    `
      SELECT
        term,
        kind,
        source,
        priority,
        pinned,
        enabled
      FROM dictionary_entries
      ORDER BY pinned DESC, priority DESC, term COLLATE NOCASE ASC;
    `
  );

  return rows.map((row) => ({
    term: row.term,
    kind: row.kind,
    source: row.source,
    priority: row.priority,
    pinned: Boolean(row.pinned),
    enabled: Boolean(row.enabled),
  }));
}

function resolveAudioPath(userDataDir, transcriptionId) {
  const audioDir = path.join(userDataDir, "audio");
  const files = fs.readdirSync(audioDir);
  const match = files.find(
    (file) => file.endsWith(`-${transcriptionId}.webm`) || file === `${transcriptionId}.webm`
  );

  if (!match) {
    throw new Error(`No retained audio found for transcription ${transcriptionId}`);
  }

  return path.join(audioDir, match);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function containsExpectedTerm(text, term) {
  const haystack = normalizeText(text);
  const needle = normalizeText(term);
  return needle.length > 0 && haystack.includes(needle);
}

function evaluateTranscript(text, expectedTerms) {
  const matchedTerms = [];
  const missingTerms = [];

  for (const term of expectedTerms || []) {
    if (containsExpectedTerm(text, term)) {
      matchedTerms.push(term);
    } else {
      missingTerms.push(term);
    }
  }

  return {
    matchedTerms,
    missingTerms,
    hitCount: matchedTerms.length,
    pass: missingTerms.length === 0,
  };
}

function inferMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".aac":
      return "audio/aac";
    default:
      return "audio/webm";
  }
}

async function transcribeOpenAICompatible({ audioPath, model, language, prompt, baseUrl, apiKey }) {
  const endpoint = baseUrl.endsWith("/audio/transcriptions")
    ? baseUrl
    : `${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  const fileName = path.basename(audioPath);
  const fileBuffer = fs.readFileSync(audioPath);
  const form = new FormData();

  form.append("file", new Blob([fileBuffer], { type: inferMimeType(audioPath) }), fileName);
  form.append("model", model);
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.error || `Transcription failed with ${response.status}`);
  }

  if (!payload?.text || typeof payload.text !== "string") {
    throw new Error("Transcription response did not include text");
  }

  return payload.text;
}

function buildPromptSelection({
  liveEntries,
  globalTerms,
  caseTerms,
  provider,
  agentName,
}) {
  const mergedEntries = dedupeDictionaryEntries([
    ...(liveEntries || []),
    ...createDictionaryEntriesFromWords(globalTerms || []),
    ...createDictionaryEntriesFromWords(caseTerms || []),
  ]);

  return buildDictionaryPrompt(mergedEntries, {
    provider,
    agentName,
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeReport(report) {
  const reportsDir = path.resolve(__dirname, "..", "validation", "reports");
  ensureDir(reportsDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `dictionary-validation-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const manifestPath = path.resolve(expandHome(args.manifest));
  const manifest = readManifest(manifestPath);
  const userDataDir = path.resolve(
    expandHome(args["user-data-dir"] || manifest.userDataDir || getDefaultUserDataDir())
  );
  const dbPath = path.join(userDataDir, "transcriptions.db");
  const baseUrl = args["base-url"] || manifest.baseUrl || "https://api.openai.com/v1";
  const model = args.model || manifest.model || "gpt-4o-mini-transcribe";
  const language = args.language || manifest.language || "";
  const provider = manifest.promptProvider || "openai";
  const apiKey = args["api-key"] || process.env.OPENAI_API_KEY || process.env.CUSTOM_TRANSCRIPTION_API_KEY;

  if (!apiKey) {
    throw new Error("No API key available. Pass --api-key or set OPENAI_API_KEY/CUSTOM_TRANSCRIPTION_API_KEY.");
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Transcriptions database not found at ${dbPath}`);
  }

  const liveEntries = manifest.useLiveDictionary === false ? [] : loadLiveDictionaryEntries(dbPath);
  const globalTerms = manifest.dictionaryTerms || [];
  const cases = manifest.cases || [];

  if (cases.length === 0) {
    throw new Error("Validation manifest has no cases.");
  }

  const reportCases = [];

  for (const testCase of cases) {
    const audioPath = testCase.audioPath
      ? path.resolve(expandHome(testCase.audioPath))
      : resolveAudioPath(userDataDir, testCase.transcriptionId);
    const expectedTerms = testCase.expectedTerms || [];
    const selection = buildPromptSelection({
      liveEntries,
      globalTerms,
      caseTerms: testCase.dictionaryTerms || [],
      provider,
      agentName: manifest.agentName || null,
    });

    const [baselineText, promptedText] = await Promise.all([
      transcribeOpenAICompatible({
        audioPath,
        model,
        language,
        prompt: null,
        baseUrl,
        apiKey,
      }),
      transcribeOpenAICompatible({
        audioPath,
        model,
        language,
        prompt: selection.prompt,
        baseUrl,
        apiKey,
      }),
    ]);

    const baseline = evaluateTranscript(baselineText, expectedTerms);
    const prompted = evaluateTranscript(promptedText, expectedTerms);

    const improved = prompted.hitCount > baseline.hitCount;
    const reportCase = {
      name: testCase.name || `case-${testCase.transcriptionId || path.basename(audioPath)}`,
      transcriptionId: testCase.transcriptionId || null,
      audioPath,
      expectedTerms,
      prompt: selection.prompt,
      promptSelectedTerms: selection.selectedEntries.map((entry) => entry.term),
      promptDroppedTerms: selection.droppedEntries,
      baselineText,
      promptedText,
      baseline,
      prompted,
      improved,
      pass: prompted.pass,
    };

    reportCases.push(reportCase);

    console.log(`\n[${reportCase.pass ? "PASS" : "FAIL"}] ${reportCase.name}`);
    console.log(`  expected: ${expectedTerms.join(", ")}`);
    console.log(`  baseline: ${baseline.hitCount}/${expectedTerms.length} matched`);
    console.log(`  prompted: ${prompted.hitCount}/${expectedTerms.length} matched`);
    console.log(`  improved: ${improved ? "yes" : "no"}`);
    if (!prompted.pass) {
      console.log(`  missing: ${prompted.missingTerms.join(", ")}`);
    }
  }

  const summary = {
    manifest: manifestPath,
    model,
    baseUrl,
    caseCount: reportCases.length,
    passedCount: reportCases.filter((entry) => entry.pass).length,
    improvedCount: reportCases.filter((entry) => entry.improved).length,
  };
  const report = { summary, cases: reportCases };
  const reportPath = writeReport(report);

  console.log(`\nSummary: ${summary.passedCount}/${summary.caseCount} passed, ${summary.improvedCount}/${summary.caseCount} improved`);
  console.log(`Report: ${reportPath}`);

  if (summary.passedCount !== summary.caseCount) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Dictionary validation failed: ${error.message}`);
  process.exit(1);
});

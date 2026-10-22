// What every exam script shares: its flags, its results folder, records and logging.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXAM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `--name value` pairs; a flag with no value is true.
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  argv.forEach((arg, i) => {
    if (!arg.startsWith("--")) return;
    const next = argv[i + 1];
    args[arg.slice(2)] = next === undefined || next.startsWith("--") ? true : next;
  });
  return args;
}

export const listArg = (value, fallback) =>
  value ? String(value).split(",").filter(Boolean) : fallback;

// --out, or a new results/<ISO time> folder.
export function resultsDir(out) {
  const dir = out || path.join(EXAM_DIR, "results", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Appends one JSON line per measurement to <dir>/records.jsonl.
export function recorder(dir) {
  const file = path.join(dir, "records.jsonl");
  return (entry) =>
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

export const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export const readJsonl = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : [];

export function median(values) {
  const sorted = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

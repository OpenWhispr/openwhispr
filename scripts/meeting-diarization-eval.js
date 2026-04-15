#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");

const FIXTURE_DIR = path.join(__dirname, "meeting-diarization-fixtures");

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    fixture: null,
    actual: null,
    list: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--fixture" && argv[i + 1]) {
      args.fixture = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--actual" && argv[i + 1]) {
      args.actual = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--list") {
      args.list = true;
      continue;
    }

    if (arg === "--json") {
      args.json = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

function readJson(filePath) {
  const source = filePath === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(filePath, "utf8");
  return JSON.parse(source);
}

function loadFixtures() {
  if (!fs.existsSync(FIXTURE_DIR)) {
    return [];
  }

  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const filePath = path.join(FIXTURE_DIR, file);
      const data = readJson(filePath);
      const input = Array.isArray(data.input) ? data.input : [];
      const expected = Array.isArray(data.expected) ? data.expected : null;

      if (!data.name) {
        data.name = path.basename(file, ".json");
      }

      if (!expected) {
        throw new Error(`Fixture ${file} is missing an expected transcript array`);
      }

      return {
        file,
        filePath,
        name: data.name,
        description: data.description || "",
        tags: Array.isArray(data.tags) ? data.tags : [],
        input,
        expected,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function selectFixtures(fixtures, filter) {
  if (!filter) {
    return fixtures;
  }

  const needle = filter.toLowerCase();
  const selected = fixtures.filter(
    (fixture) =>
      fixture.name.toLowerCase().includes(needle) || fixture.file.toLowerCase().includes(needle)
  );

  if (selected.length === 0) {
    throw new Error(`No fixtures matched "${filter}"`);
  }

  return selected;
}

function resolveActual(candidate, fixtureName) {
  if (Array.isArray(candidate)) {
    return candidate;
  }

  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  if (Array.isArray(candidate.segments)) {
    return candidate.segments;
  }

  if (Array.isArray(candidate.meetingSegments)) {
    return candidate.meetingSegments;
  }

  if (candidate.fixtures && typeof candidate.fixtures === "object") {
    const nested = candidate.fixtures[fixtureName];
    if (nested != null) {
      return resolveActual(nested, fixtureName);
    }
  }

  if (candidate.results && typeof candidate.results === "object") {
    const nested = candidate.results[fixtureName];
    if (nested != null) {
      return resolveActual(nested, fixtureName);
    }
  }

  if (candidate[fixtureName] != null) {
    return resolveActual(candidate[fixtureName], fixtureName);
  }

  return null;
}

function summarizeSegments(segments) {
  const speakers = new Set();
  let micCount = 0;
  let systemCount = 0;
  let placeholderCount = 0;

  for (const segment of segments) {
    if (segment?.speaker) {
      speakers.add(segment.speaker);
    }
    if (segment?.source === "mic") micCount += 1;
    if (segment?.source === "system") systemCount += 1;
    if (segment?.speakerIsPlaceholder) placeholderCount += 1;
  }

  return {
    total: segments.length,
    speakers: speakers.size,
    micCount,
    systemCount,
    placeholderCount,
  };
}

function compareExpectedToActual(expected, actual) {
  const mismatches = [];
  const count = Math.min(expected.length, actual.length);

  if (expected.length !== actual.length) {
    mismatches.push({
      type: "length",
      expected: expected.length,
      actual: actual.length,
    });
  }

  for (let i = 0; i < count; i += 1) {
    const expectedSegment = expected[i];
    const actualSegment = actual[i];
    const keys = Object.keys(expectedSegment).filter((key) => expectedSegment[key] !== undefined);

    for (const key of keys) {
      if (!isDeepStrictEqual(actualSegment?.[key], expectedSegment[key])) {
        mismatches.push({
          type: "field",
          index: i,
          field: key,
          expected: expectedSegment[key],
          actual: actualSegment?.[key],
        });
      }
    }
  }

  return mismatches;
}

function printUsage() {
  console.log(`Usage:
  node scripts/meeting-diarization-eval.js [--fixture <name>] [--actual <file>|-] [--list] [--json]

Options:
  --fixture <name>   Filter to one fixture by name or file fragment
  --actual <file>    Compare a candidate transcript JSON file against the fixture expected output
  --actual -         Read the candidate JSON from stdin
  --list             Show available fixtures and scenario summaries
  --json             Emit machine-readable results when running comparisons
  -h, --help         Show this help

Candidate JSON can be either an array of segments or an object with a \`segments\` or
\`meetingSegments\` array. Extra fields are ignored; the harness compares the fields that
appear in each fixture's expected output.`);
}

function main() {
  const args = parseArgs();

  if (args.help) {
    printUsage();
    return;
  }

  const fixtures = selectFixtures(loadFixtures(), args.fixture);

  if (args.list || !args.actual) {
    if (!args.json) {
      console.log(`Loaded ${fixtures.length} diarization fixture${fixtures.length === 1 ? "" : "s"}:\n`);
      for (const fixture of fixtures) {
        const inputSummary = summarizeSegments(fixture.input);
        const expectedSummary = summarizeSegments(fixture.expected);
        const removed = Math.max(0, inputSummary.total - expectedSummary.total);
        const tags = fixture.tags.length ? ` [${fixture.tags.join(", ")}]` : "";
        console.log(`- ${fixture.name}${tags}`);
        if (fixture.description) {
          console.log(`  ${fixture.description}`);
        }
        console.log(
          `  ${inputSummary.total} input -> ${expectedSummary.total} expected, ${expectedSummary.speakers} speakers${removed ? `, ${removed} trimmed` : ""}`
        );
      }
      console.log(
        `\nRun \`node scripts/meeting-diarization-eval.js --fixture <name> --actual <file>\` to compare a debug export against one scenario.`
      );
    }
    return;
  }

  const actualPath = path.resolve(args.actual);
  const candidate = readJson(actualPath);
  const results = [];

  for (const fixture of fixtures) {
    const actual = resolveActual(candidate, fixture.name);
    if (!actual) {
      throw new Error(
        `Could not find candidate transcript for fixture "${fixture.name}" in ${actualPath}`
      );
    }

    const mismatches = compareExpectedToActual(fixture.expected, actual);
    const pass = mismatches.length === 0;
    results.push({
      name: fixture.name,
      description: fixture.description,
      pass,
      expectedCount: fixture.expected.length,
      actualCount: actual.length,
      mismatches,
    });
  }

  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;

  if (args.json) {
    console.log(JSON.stringify({ passed, failed, results }, null, 2));
  } else {
    for (const result of results) {
      const status = result.pass ? "PASS" : "FAIL";
      console.log(`${status} ${result.name} (${result.actualCount}/${result.expectedCount} segments)`);

      if (!result.pass) {
        for (const mismatch of result.mismatches.slice(0, 8)) {
          if (mismatch.type === "length") {
            console.log(`  length mismatch: expected ${mismatch.expected}, got ${mismatch.actual}`);
            continue;
          }

          console.log(
            `  segment ${mismatch.index} field "${mismatch.field}": expected ${JSON.stringify(
              mismatch.expected
            )}, got ${JSON.stringify(mismatch.actual)}`
          );
        }
      }
    }

    console.log(`\n${passed}/${results.length} fixtures passed`);
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

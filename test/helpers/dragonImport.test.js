const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/helpers/dragonImport.js");
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));

test("decodeDragonExport reads UTF-8 without a BOM", async () => {
  const { decodeDragonExport } = await load();
  const out = decodeDragonExport(Buffer.from("@Version=Plato-UTF8\r\nZoë\r\n", "utf8"));
  assert.equal(out.encoding, "utf-8");
  assert.equal(out.text, "@Version=Plato-UTF8\r\nZoë\r\n");
});

test("decodeDragonExport strips a UTF-8 BOM", async () => {
  const { decodeDragonExport } = await load();
  const out = decodeDragonExport(
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Zoë", "utf8")])
  );
  assert.equal(out.encoding, "utf-8");
  assert.equal(out.text, "Zoë");
});

test("decodeDragonExport reads UTF-16 LE and BE by BOM", async () => {
  const { decodeDragonExport } = await load();
  const le = decodeDragonExport(Buffer.from("\ufeffZoë", "utf16le"));
  assert.deepEqual(le, { text: "Zoë", encoding: "utf-16le" });
  const be = Buffer.from("\ufeffZoë", "utf16le").swap16();
  assert.deepEqual(decodeDragonExport(be), { text: "Zoë", encoding: "utf-16be" });
});

test("decodeDragonExport falls back to Windows-1252 when bytes are not UTF-8", async () => {
  const { decodeDragonExport } = await load();
  const out = decodeDragonExport(Buffer.from([0x5a, 0x6f, 0xeb])); // "Zoë" in cp1252
  assert.deepEqual(out, { text: "Zoë", encoding: "windows-1252" });
});

test("parseDragonWordList reads a real-shaped export: header, pairs, CRLF, duplicates", async () => {
  const { parseDragonWordList, decodeDragonExport } = await load();
  const result = parseDragonWordList(decodeDragonExport(fixture("dragon-export-sample.txt")).text);
  assert.equal(result.ok, true);
  assert.equal(result.format, "txt");
  assert.equal(result.header, "@Version=Plato-UTF8");
  assert.deepEqual(result.words, [
    "Applas",
    "Accessibility Directorate",
    "ADO",
    "Robert F. Kennedy",
    "(",
    "MB",
  ]);
  assert.equal(result.totalEntries, 7);
  assert.equal(result.duplicatesInFile, 1); // "applas" repeats "Applas"
  assert.deepEqual(result.warnings, []);
});

test("parseDragonWordList accepts every header variant and none", async () => {
  const { parseDragonWordList } = await load();
  for (const header of [
    "@Version=Plato-UTF8",
    "@version=Plato-UTF8",
    "@Version=Plato",
    "@VERSION = plato",
  ]) {
    const r = parseDragonWordList(`${header}\nalpha\n`);
    assert.equal(r.header, header, header);
    assert.deepEqual(r.words, ["alpha"]);
  }
  const bare = parseDragonWordList("alpha\nbeta\n");
  assert.equal(bare.header, null);
  assert.deepEqual(bare.words, ["alpha", "beta"]);
});

test("parseDragonWordList splits at the LAST separator and accepts a single backslash", async () => {
  const { parseDragonWordList } = await load();
  const r = parseDragonWordList(
    "C:\\\\temp\\\\spoken form\nold style\\spoken\nback\\\\slash\\\\word\n"
  );
  assert.deepEqual(r.words, ["C:\\\\temp", "old style", "back\\\\slash"]);
});

test("parseDragonWordList skips a line with no written form and reports it", async () => {
  const { parseDragonWordList } = await load();
  const r = parseDragonWordList("@Version=Plato-UTF8\n\\\\only spoken\nreal word\n");
  assert.deepEqual(r.words, ["real word"]);
  assert.deepEqual(r.warnings, [{ code: "AMBIGUOUS_BACKSLASH", line: 2 }]);
});

test("parseDragonWordList treats a header-only or blank file as empty", async () => {
  const { parseDragonWordList } = await load();
  assert.deepEqual(parseDragonWordList("@Version=Plato-UTF8\r\n\r\n"), {
    ok: false,
    error: { code: "EMPTY_FILE" },
  });
  assert.deepEqual(parseDragonWordList(""), { ok: false, error: { code: "EMPTY_FILE" } });
});

test("planDragonImport drops words already present, case-insensitively, keeping file order", async () => {
  const { planDragonImport } = await load();
  const plan = planDragonImport(["Applas", "ADO", "Zoë"], ["ado", " Zoë "]);
  assert.deepEqual(plan, { add: ["Applas"], skippedExisting: 2 });
});

// Header copied verbatim from a real Dragon Professional Individual 14 export
// (mdbridge bug report #160215-001402); body trimmed to three words.
const DRAGON_XML = `<?xml version="1.0" encoding="utf-16"?>

<!DOCTYPE WordExport SYSTEM "http://dragoncontent.nuance.com/dtds/Words10.dtd">

<WordExport NatspeakVersion="14.00.000.180" NatspeakEdition="ProfessionalIndividual" User="Mark virgin" Topic="General - Medium" Language="ENX" MRECVersion="1.28.100.16375">

\t<Word name="POE RAY\\\\Poe Ray">
\t</Word>
\t<Word name="(\\\\left parenthesis">
\t</Word>
\t<Word name="Oertli">
\t</Word>
\t<Word name="A &amp; B\\\\A and B">
\t</Word>

</WordExport>
`;

test("parseDragonWordList reads a Windows Dragon XML export", async () => {
  const { parseDragonWordList } = await load();
  const r = parseDragonWordList(DRAGON_XML);
  assert.equal(r.ok, true);
  assert.equal(r.format, "xml");
  assert.equal(r.header, null);
  assert.deepEqual(r.words, ["POE RAY", "(", "Oertli", "A & B"]);
  assert.deepEqual(r.warnings, []);
});

test("parseDragonWordList decodes UTF-16 XML end to end", async () => {
  const { parseDragonWordList, decodeDragonExport } = await load();
  const bytes = Buffer.from("﻿" + DRAGON_XML, "utf16le");
  const r = parseDragonWordList(decodeDragonExport(bytes).text);
  assert.deepEqual(r.words, ["POE RAY", "(", "Oertli", "A & B"]);
});

test("parseDragonWordList flags word properties it cannot map", async () => {
  const { parseDragonWordList } = await load();
  const withProps = DRAGON_XML.replace(
    '<Word name="Oertli">\n\t</Word>',
    '<Word name="Oertli">\n\t\t<Property id="1">x</Property>\n\t</Word>'
  );
  const r = parseDragonWordList(withProps);
  assert.deepEqual(r.words, ["POE RAY", "(", "Oertli", "A & B"]);
  assert.deepEqual(r.warnings, [{ code: "XML_PROPERTIES_IGNORED" }]);
});

test("parseDragonWordList reads self-closing Word tags without false-flagging properties", async () => {
  const { parseDragonWordList } = await load();
  const xml =
    '<?xml version="1.0"?><WordExport>' +
    '<Word name="alpha" />' +
    '<Word name="beta" />' +
    "</WordExport>";
  const r = parseDragonWordList(xml);
  assert.equal(r.ok, true);
  assert.deepEqual(r.words, ["alpha", "beta"]);
  assert.deepEqual(r.warnings, []);
});

test("parseDragonWordList decodes numeric entities and leaves an out-of-range reference literal", async () => {
  const { parseDragonWordList } = await load();
  const xml =
    '<?xml version="1.0"?><WordExport>' +
    '<Word name="caf&#233; &#xE9;"></Word>' +
    '<Word name="bad &#1114112; word"></Word>' +
    "</WordExport>";
  const r = parseDragonWordList(xml);
  assert.equal(r.ok, true);
  assert.deepEqual(r.words, ["café é", "bad &#1114112; word"]);
});

test("parseDragonWordList refuses XML that is not a Windows Dragon export", async () => {
  const { parseDragonWordList } = await load();
  const mac = '<?xml version="1.0"?><vocabulary><item written="x" spoken="y"/></vocabulary>';
  assert.deepEqual(parseDragonWordList(mac), { ok: false, error: { code: "UNSUPPORTED_XML" } });
});

test("parseDragonWordList treats a WordExport with no words as empty", async () => {
  const { parseDragonWordList } = await load();
  const r = parseDragonWordList('<?xml version="1.0"?><WordExport></WordExport>');
  assert.deepEqual(r, { ok: false, error: { code: "EMPTY_FILE" } });
});

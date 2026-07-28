const { formatMd } = await import("./src/helpers/transcriptFormatter.js");
const note = { title: "Meeting transcript", created_at: "2026-01-01T00:00:00Z" };
const out = formatMd(note, [{ text: "hello", timestamp: 0 }], {});
console.log("first 20 bytes:", JSON.stringify(out.slice(0, 20)));
console.log("starts with ---\\n ?", out.slice(0, 4) === "---\n");

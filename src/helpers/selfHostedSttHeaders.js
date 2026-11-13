export function parseSelfHostedSttHeaders(serialized) {
  if (!serialized) return [];
  try {
    const rows = JSON.parse(serialized);
    if (
      Array.isArray(rows) &&
      rows.every((row) => typeof row?.name === "string" && typeof row?.value === "string")
    )
      return rows;
  } catch {}
  return [];
}

export function mergeSelfHostedSttHeaders(rows = [], existing = {}) {
  const headers = new Headers();
  const protectedNames = new Set([
    "content-type",
    "content-length",
    "host",
    "transfer-encoding",
    "connection",
    "upgrade",
    "trailer",
    "te",
    "proxy-authorization",
    "proxy-authenticate",
  ]);
  for (const row of rows) {
    if (!row?.name && !row?.value) continue;
    if (
      typeof row?.name !== "string" ||
      typeof row?.value !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.name) ||
      /[^\t\x20-\x7e\x80-\xff]/.test(row.value) ||
      protectedNames.has(row.name.toLowerCase())
    ) {
      throw Object.assign(new Error("Invalid self-hosted STT HTTP header."), {
        errorCode: "invalidHeaders",
      });
    }
    headers.set(row.name, row.value);
  }
  for (const [name, value] of new Headers(existing)) headers.set(name, value);
  return Object.fromEntries(headers);
}

/**
 * CJS port of src/utils/urlUtils.ts — needed by ipcHandlers.js (CommonJS).
 */

function normalizeIP(hostname) {
  // Strip IPv6 brackets
  let h = hostname.replace(/^\[|\]$/g, "");

  // Handle IPv4-mapped IPv6 (::ffff:1.2.3.4)
  const v4mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mapped) h = v4mapped[1];

  // Try parsing as a single decimal/hex integer (e.g., 2130706433, 0x7f000001)
  if (/^(0x[\da-f]+|\d+)$/i.test(h)) {
    const num = Number(h);
    if (Number.isInteger(num) && num >= 0 && num <= 0xffffffff) {
      return `${(num >>> 24) & 0xff}.${(num >>> 16) & 0xff}.${(num >>> 8) & 0xff}.${num & 0xff}`;
    }
  }

  // Try parsing dotted notation with octal/hex octets (e.g., 0177.0.0.1)
  const parts = h.split(".");
  if (parts.length === 4) {
    const octets = parts.map((p) => {
      if (/^0x[\da-f]+$/i.test(p)) return parseInt(p, 16);
      if (/^0\d+$/.test(p)) return parseInt(p, 8);
      if (/^\d+$/.test(p)) return parseInt(p, 10);
      return NaN;
    });
    if (octets.every((o) => !isNaN(o) && o >= 0 && o <= 255)) {
      return octets.join(".");
    }
  }

  return h;
}

function isPrivateHost(hostname) {
  const h = normalizeIP(hostname.toLowerCase());

  if (h === "localhost" || h === "0.0.0.0" || h.startsWith("127.")) return true;
  if (h === "::1") return true;
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
  if (h.startsWith("172.")) {
    const octet = parseInt(h.split(".")[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }
  if (h.startsWith("169.254.")) return true;

  const isIPv6 = h.includes(":");
  if (isIPv6 && (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd"))) return true;
  if (h.endsWith(".local")) return true;

  return false;
}

function isSecureEndpoint(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

module.exports = { isPrivateHost, isSecureEndpoint };

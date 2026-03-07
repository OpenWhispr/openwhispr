/**
 * Canonical URL validation helpers — used by both main process (CJS) and renderer (ESM via Vite).
 */

function normalizeIP(hostname) {
  // Strip IPv6 brackets
  let h = hostname.replace(/^\[|\]$/g, "");

  // Handle IPv4-mapped IPv6 dotted form (::ffff:1.2.3.4)
  const v4mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mapped) h = v4mapped[1];

  // Handle IPv4-mapped IPv6 hex-pair form (::ffff:7f00:0001)
  const v4hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4hex) {
    const high = parseInt(v4hex[1], 16);
    const low = parseInt(v4hex[2], 16);
    h = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }

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

  // Handle abbreviated dotted notation (e.g., 127.1 → 127.0.0.1)
  if (parts.length >= 2 && parts.length <= 3) {
    const nums = parts.map((p) => {
      if (/^0x[\da-f]+$/i.test(p)) return parseInt(p, 16);
      if (/^0\d+$/.test(p)) return parseInt(p, 8);
      if (/^\d+$/.test(p)) return parseInt(p, 10);
      return NaN;
    });
    if (nums.every((n) => !isNaN(n))) {
      const last = nums[nums.length - 1];
      if (parts.length === 2 && nums[0] >= 0 && nums[0] <= 255 && last >= 0 && last <= 0xffffff) {
        return `${nums[0]}.${(last >> 16) & 0xff}.${(last >> 8) & 0xff}.${last & 0xff}`;
      }
      if (parts.length === 3 && nums[0] >= 0 && nums[0] <= 255 && nums[1] >= 0 && nums[1] <= 255 && last >= 0 && last <= 0xffff) {
        return `${nums[0]}.${nums[1]}.${(last >> 8) & 0xff}.${last & 0xff}`;
      }
    }
  }

  return h;
}

function isPrivateHost(hostname) {
  const h = normalizeIP(hostname.toLowerCase());

  if (h === "localhost" || h === "0.0.0.0" || h.startsWith("0.") || h.startsWith("127.")) return true;
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

const METADATA_HOSTS = new Set([
  "169.254.169.254",          // AWS, GCP, Azure metadata
  "metadata.google.internal", // GCP metadata hostname
]);

function isCloudMetadataHost(hostname) {
  const h = normalizeIP(hostname.toLowerCase().replace(/^\[|\]$/g, ""));
  if (METADATA_HOSTS.has(h)) return true;
  // Block fe80:: link-local (used for Azure metadata via fe80::1)
  if (h.includes(":") && h.startsWith("fe80")) return true;
  return false;
}

function isSecureEndpoint(url) {
  try {
    const parsed = new URL(url);
    // Only allow http: and https: schemes — reject ftp:, file:, ws:, gopher:, etc.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (isCloudMetadataHost(parsed.hostname)) return false;
    // HTTPS is always allowed; HTTP only for private/local hosts
    return parsed.protocol === "https:" || isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

export { isPrivateHost, isCloudMetadataHost, isSecureEndpoint };

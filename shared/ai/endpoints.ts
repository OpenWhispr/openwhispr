// Require a real dotted-quad before applying IPv4 private-range checks so
// public DNS names like "127.example.com" / "10.example.com" cannot bypass
// the HTTPS requirement via string-prefix matching.
function parseIPv4Literal(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    // Reject empty labels, leading zeros ("01"), and non-decimal forms.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }

  return octets;
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h === "0.0.0.0") return true;
  if (h === "::1") return true;

  const ipv4 = parseIPv4Literal(h);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // RFC 6598 CGNAT (Tailscale): 100.64.0.0/10
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
  }

  const isIPv6 = h.includes(":");
  // Link-local is fe80::/10 (fe80–febf), not only the fe80 hextet. Same rule as
  // isPrivateIp in urlAudioDownloader.js. Unique local is fc00::/7 (fc/fd).
  if (isIPv6 && (/^fe[89ab]/.test(h) || h.startsWith("fc") || h.startsWith("fd"))) return true;
  if (h.endsWith(".local")) return true;
  // Tailscale MagicDNS — resolves to CGNAT (100.64/10) addresses reachable
  // only inside the user's own tailnet.
  if (h.endsWith(".ts.net")) return true;

  return false;
}

export function isSecureHttpEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && isPrivateHost(parsed.hostname))
    );
  } catch {
    return false;
  }
}

// Split query/hash so path-suffix stripping and later joins operate on the
// path only. Provider docs and Azure/gateway pastes often include ?api-version=
// (or similar) on a full /chat/completions URL (#1309).
function splitUrlDecorators(value: string): { path: string; query: string; hash: string } {
  let path = value;
  let hash = "";
  const hashIndex = path.indexOf("#");
  if (hashIndex >= 0) {
    hash = path.slice(hashIndex);
    path = path.slice(0, hashIndex);
  }
  let query = "";
  const queryIndex = path.indexOf("?");
  if (queryIndex >= 0) {
    query = path.slice(queryIndex);
    path = path.slice(0, queryIndex);
  }
  return { path, query, hash };
}

function joinUrlDecorators(path: string, query: string, hash: string): string {
  return `${path}${query}${hash}`;
}

// API Configuration helpers
export const normalizeBaseUrl = (value?: string | null): string => {
  if (!value) return "";

  const trimmed = value.trim();
  if (!trimmed) return "";

  const { path: rawPath, query, hash } = splitUrlDecorators(trimmed);
  let normalized = rawPath;

  // Remove common API endpoint suffixes to get the base URL
  const suffixReplacements: Array<[RegExp, string]> = [
    [/\/v1\/chat\/completions$/i, "/v1"],
    [/\/chat\/completions$/i, ""],
    [/\/v1\/responses$/i, "/v1"],
    [/\/responses$/i, ""],
    [/\/v1\/models$/i, "/v1"],
    [/\/models$/i, ""],
    [/\/v1\/audio\/transcriptions$/i, "/v1"],
    [/\/audio\/transcriptions$/i, ""],
    [/\/v1\/audio\/translations$/i, "/v1"],
    [/\/audio\/translations$/i, ""],
  ];

  for (const [pattern, replacement] of suffixReplacements) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, replacement).replace(/\/+$/, "");
    }
  }

  return joinUrlDecorators(normalized.replace(/\/+$/, ""), query, hash);
};

export const buildApiUrl = (base: string, path: string): string => {
  const normalizedBase = normalizeBaseUrl(base) || "https://api.openai.com/v1";
  if (!path) {
    return normalizedBase;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const { path: originAndPath, query, hash } = splitUrlDecorators(normalizedBase);
  return joinUrlDecorators(`${originAndPath}${normalizedPath}`, query, hash);
};

export const ensureV1Suffix = (base: string): string => {
  if (!base) return base;
  const normalized = normalizeBaseUrl(base) || base;
  const { path, query, hash } = splitUrlDecorators(normalized);
  return joinUrlDecorators(path.endsWith("/v1") ? path : `${path}/v1`, query, hash);
};

// Ordered bases to try when listing models from an OpenAI-compatible server.
// Self-hosted servers (LM Studio, Ollama, vLLM) serve the API under /v1 even
// when users enter the bare origin, and LM Studio's native REST base
// (/api/v1 or /api/v0) has its OpenAI-compatible sibling at /v1.
export const getModelListBaseCandidates = (base: string): string[] => {
  const normalized = normalizeBaseUrl(base);
  if (!normalized) return [];
  const { path, query, hash } = splitUrlDecorators(normalized);
  const nativeApiMatch = path.match(/^(.+?)\/api\/v[01]$/i);
  if (nativeApiMatch) {
    return [normalized, joinUrlDecorators(`${nativeApiMatch[1]}/v1`, query, hash)];
  }
  const withV1 = ensureV1Suffix(normalized);
  return withV1 === normalized ? [normalized] : [normalized, withV1];
};

const CANONICAL_APP_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type AppVersionParts = readonly [number, number, number];

function parseCanonicalAppVersion(value: unknown): AppVersionParts | null {
  if (typeof value !== "string") return null;

  const match = CANONICAL_APP_VERSION.exec(value);
  if (!match) return null;

  const parts: AppVersionParts = [Number(match[1]), Number(match[2]), Number(match[3])];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isCanonicalAppVersion(value: unknown): value is string {
  return parseCanonicalAppVersion(value) !== null;
}

/** Returns negative when a < b, positive when a > b, and zero when equal. */
export function compareAppVersions(a: string, b: string): number {
  const left = parseCanonicalAppVersion(a);
  const right = parseCanonicalAppVersion(b);
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}
